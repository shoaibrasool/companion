import { useReducer, useState, useRef, useEffect, useCallback } from "react"
import type { Message, WebSocketMessage } from "./types"
import ChatView from "./ChatView"
import VoiceView from "./VoiceView"
import "./App.css"

type Mode = "chat" | "voice"

function getSessionId(): string {
  const stored = localStorage.getItem("companion_session_id")
  if (stored) return stored
  const id = crypto.randomUUID()
  localStorage.setItem("companion_session_id", id)
  return id
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
  const [mode, setMode] = useState<Mode>("chat")
  const modeRef = useRef(mode)
  modeRef.current = mode

  const sessionId = useRef(getSessionId())
  const [{ messages, pendingText, isThinking }, dispatch] = useReducer(
    chatReducer,
    initialChatState,
  )
  const [inputText, setInputText] = useState("")
  const [isConnected, setIsConnected] = useState(false)
  const [backendReady, setBackendReady] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)

  const playbackCtxRef = useRef<AudioContext | null>(null)
  const pendingRef = useRef<ArrayBuffer[]>([])
  const nextStartTimeRef = useRef<number>(0)
  const isProcessingRef = useRef(false)

  const isAiResponding = isThinking || pendingText.length > 0

  useEffect(() => {
    const baseUrl = import.meta.env.VITE_API_URL || "http://localhost:8000"
    fetch(`${baseUrl}/health`)
      .then((res) => res.json())
      .then(() => setBackendReady(true))
      .catch(() => setBackendReady(false))
  }, [])

  const clearAudioQueue = useCallback(() => {
    pendingRef.current = []
    isProcessingRef.current = false
    if (playbackCtxRef.current && playbackCtxRef.current.state !== "closed") {
      playbackCtxRef.current.close()
    }
    playbackCtxRef.current = null
    nextStartTimeRef.current = 0
  }, [])

  const processNext = useCallback(() => {
    if (isProcessingRef.current) return
    if (pendingRef.current.length === 0) return

    isProcessingRef.current = true
    const buffer = pendingRef.current.shift()!

    if (!playbackCtxRef.current || playbackCtxRef.current.state === "closed") {
      playbackCtxRef.current = new AudioContext()
      nextStartTimeRef.current = 0
    }

    const ctx = playbackCtxRef.current
    if (ctx.state === "suspended") {
      ctx.resume()
    }

    ctx.decodeAudioData(buffer.slice(0))
      .then((decoded) => {
        const source = ctx.createBufferSource()
        source.buffer = decoded
        source.connect(ctx.destination)

        const now = ctx.currentTime
        const startTime = Math.max(now, nextStartTimeRef.current)
        source.start(startTime)
        nextStartTimeRef.current = startTime + decoded.duration
      })
      .catch((err) => {
        console.error("Audio decode error:", err)
      })
      .finally(() => {
        isProcessingRef.current = false
        processNext()
      })
  }, [])

  const sendAudio = useCallback((b64: string) => {
    const binaryStr = atob(b64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }
    pendingRef.current.push(bytes.buffer)
    processNext()
  }, [processNext])

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
      } else if (data.type === "audio" && modeRef.current === "voice") {
        sendAudio(data.content)
      }
    }

    return () => ws.close()
  }, [backendReady, sendAudio])

  useEffect(() => {
    if (mode === "chat") clearAudioQueue()
  }, [mode, clearAudioQueue])

  const handleSendText = useCallback((text: string) => {
    if (!text || !wsRef.current) return

    clearAudioQueue()

    if (!playbackCtxRef.current || playbackCtxRef.current.state === "closed") {
      playbackCtxRef.current = new AudioContext()
      nextStartTimeRef.current = 0
    }
    const ctx = playbackCtxRef.current
    if (ctx.state === "suspended") {
      ctx.resume()
    }

    wsRef.current.send(text)
    dispatch({ type: "send", text })
  }, [clearAudioQueue])

  const handleSendMessage = useCallback(() => {
    handleSendText(inputText.trim())
    setInputText("")
  }, [handleSendText, inputText])

  return (
    <div className="app">
      <header>
        <h1>Companion</h1>
        <div className="header-right">
          <div className="mode-switcher">
            <button
              className={`mode-btn ${mode === "chat" ? "active" : ""}`}
              onClick={() => setMode("chat")}
            >
              Chat
            </button>
            <button
              className={`mode-btn ${mode === "voice" ? "active" : ""}`}
              onClick={() => setMode("voice")}
            >
              Voice
            </button>
          </div>
          <div className="status-group">
            <span className={`status-dot ${isConnected ? "connected" : "disconnected"}`} />
            <span className="session-id">session: {sessionId.current.slice(0, 8)}</span>
          </div>
        </div>
      </header>

      {mode === "chat" ? (
        <ChatView
          messages={messages}
          pendingText={pendingText}
          isThinking={isThinking}
          inputText={inputText}
          onInputChange={setInputText}
          onSend={handleSendMessage}
          isConnected={isConnected}
        />
      ) : (
        <VoiceView
          isConnected={isConnected}
          isAiResponding={isAiResponding}
          onSendText={handleSendText}
          clearAudioQueue={clearAudioQueue}
        />
      )}

      {!backendReady && (
        <div className="overlay">
          <p>Connecting to backend...</p>
        </div>
      )}
    </div>
  )
}

export default App