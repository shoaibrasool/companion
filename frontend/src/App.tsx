import { useReducer, useState, useRef, useEffect, useCallback } from "react"
import type { Message, WebSocketMessage } from "./types"
import "./App.css"

function getSessionId(): string {
  const stored = localStorage.getItem("companion_session_id")
  if (stored) return stored
  const id = crypto.randomUUID()
  localStorage.setItem("companion_session_id", id)
  return id
}

const TARGET_SR = 16000

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = samples.length * (bitsPerSample / 8)
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
  }
  w(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  w(8, "WAVE")
  w(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  w(36, "data")
  view.setUint32(40, dataSize, true)

  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return new Blob([buffer], { type: "audio/wav" })
}

type ChatState = {
  messages: Message[]
  pendingText: string
  isThinking: boolean
}

type Action =
  | { type: "token"; content: string }
  | { type: "done" }
  | { type: "send"; text: string }

const initialChatState: ChatState = {
  messages: [],
  pendingText: "",
  isThinking: false,
}

function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "token":
      return {
        ...state,
        isThinking: false,
        pendingText: state.pendingText + action.content,
      }
    case "done": {
      const next = { ...state, isThinking: false }
      if (state.pendingText) {
        next.messages = [
          ...state.messages,
          { role: "ai", content: state.pendingText },
        ]
      }
      next.pendingText = ""
      return next
    }
    case "send":
      return {
        messages: [
          ...state.messages,
          { role: "human", content: action.text },
        ],
        pendingText: "",
        isThinking: true,
      }
  }
}

function App() {
  const sessionId = useRef(getSessionId())
  const [{ messages, pendingText, isThinking }, dispatch] = useReducer(
    chatReducer,
    initialChatState,
  )
  const [inputText, setInputText] = useState("")
  const [isConnected, setIsConnected] = useState(false)
  const [backendReady, setBackendReady] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Float32Array[]>([])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "instant" })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, pendingText, scrollToBottom])

  useEffect(() => {
    const baseUrl = import.meta.env.VITE_API_URL || "http://localhost:8000"
    fetch(`${baseUrl}/health`)
      .then((res) => res.json())
      .then(() => setBackendReady(true))
      .catch(() => setBackendReady(false))
  }, [])

  useEffect(() => {
    if (!backendReady) return

    const baseUrl = import.meta.env.VITE_API_URL || "http://localhost:8000"
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws/${sessionId.current}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => setIsConnected(true)
    ws.onclose = () => setIsConnected(false)
    ws.onerror = () => setIsConnected(false)

    ws.onmessage = (event: MessageEvent<string>) => {
      const data: WebSocketMessage = JSON.parse(event.data)
      if (data.type === "token") {
        dispatch({ type: "token", content: data.content })
      } else if (data.type === "done") {
        dispatch({ type: "done" })
      }
    }

    return () => ws.close()
  }, [backendReady])

  const sendMessage = useCallback(() => {
    const text = inputText.trim()
    if (!text || !wsRef.current) return
    wsRef.current.send(text)
    dispatch({ type: "send", text })
    setInputText("")
  }, [inputText])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioCtx = new AudioContext({ sampleRate: TARGET_SR })
      audioCtxRef.current = audioCtx

      const source = audioCtx.createMediaStreamSource(stream)
      sourceRef.current = source

      const processor = audioCtx.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor

      chunksRef.current = []

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        chunksRef.current.push(
          new Float32Array(e.inputBuffer.getChannelData(0)),
        )
      }

      source.connect(processor)
      processor.connect(audioCtx.destination)

      setIsRecording(true)
    } catch (err) {
      console.error("Mic access denied:", err)
    }
  }, [])

  const stopRecording = useCallback(async () => {
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    audioCtxRef.current?.close()

    streamRef.current?.getTracks().forEach((t) => t.stop())

    const totalLen = chunksRef.current.reduce((s, a) => s + a.length, 0)
    const combined = new Float32Array(totalLen)
    let offset = 0
    for (const arr of chunksRef.current) {
      combined.set(arr, offset)
      offset += arr.length
    }

    setIsRecording(false)

    if (combined.length === 0) return

    setIsTranscribing(true)

    const wavBlob = encodeWav(combined, TARGET_SR)
    const formData = new FormData()
    formData.append("file", wavBlob, "recording.wav")

    try {
      const baseUrl = import.meta.env.VITE_API_URL || "http://localhost:8000"
      const res = await fetch(`${baseUrl}/transcribe`, {
        method: "POST",
        body: formData,
      })
      if (!res.ok) throw new Error(`Transcribe failed: ${res.statusText}`)
      const data = await res.json()
      const text: string = data.text
      if (text && wsRef.current) {
        wsRef.current.send(text)
        dispatch({ type: "send", text })
      }
    } catch (err) {
      console.error("Transcription error:", err)
    } finally {
      setIsTranscribing(false)
    }
  }, [])

  return (
    <div className="app">
      <header>
        <h1>Companion</h1>
        <div className="status-group">
          <span className={`status-dot ${isConnected ? "connected" : "disconnected"}`} />
          <span className="session-id">session: {sessionId.current.slice(0, 8)}</span>
        </div>
      </header>

      <div className="messages">
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            <div className="bubble">{msg.content}</div>
          </div>
        ))}

        {isThinking && (
          <div className="message ai">
            <div className="bubble thinking">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}

        {!isThinking && pendingText && (
          <div className="message ai">
            <div className="bubble streaming">{pendingText}</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-bar">
        <input
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder={
            isRecording
              ? "Recording..."
              : isTranscribing
                ? "Transcribing..."
                : isConnected
                  ? "Type a message..."
                  : "Waiting for connection..."
          }
          disabled={!isConnected || isRecording || isTranscribing}
        />
        {isRecording ? (
          <button className="record-btn recording" onClick={stopRecording}>
            Stop
          </button>
        ) : (
          <button
            className="record-btn"
            onClick={startRecording}
            disabled={!isConnected || isTranscribing}
            title="Record voice"
          >
            {isTranscribing ? "..." : "\u{1F3A4}"}
          </button>
        )}
        <button onClick={sendMessage} disabled={!isConnected || !inputText.trim() || isRecording}>
          Send
        </button>
      </div>

      {!backendReady && (
        <div className="overlay">
          <p>Connecting to backend...</p>
        </div>
      )}
    </div>
  )
}

export default App