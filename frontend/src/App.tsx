import { useReducer, useState, useRef, useEffect, useCallback } from "react"
import type { Message, WebSocketMessage } from "./types"
import ChatView from "./ChatView"
import VoiceView from "./VoiceView"
import "./App.css"

type Mode = "chat" | "voice"
type Theme = "light" | "dark"

function getInitialTheme(): Theme {
  const stored = localStorage.getItem("companion_theme")
  if (stored === "light" || stored === "dark") return stored
  return "light"
}

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
  | { type: "history"; messages: Message[] }

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
    case "history":
      return {
        ...state,
        messages: action.messages,
        pendingText: "",
        isThinking: false,
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
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const [inputText, setInputText] = useState("")
  const [isConnected, setIsConnected] = useState(false)
  const [backendReady, setBackendReady] = useState(false)
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  const wsRef = useRef<WebSocket | null>(null)

  const playbackCtxRef = useRef<AudioContext | null>(null)
  const pendingRef = useRef<{ buffer: ArrayBuffer; index: number }[]>([])
  const nextStartTimeRef = useRef<number>(0)
  const isProcessingRef = useRef(false)
  const sourcesRef = useRef<AudioBufferSourceNode[]>([])
  const analyserRef = useRef<AnalyserNode | null>(null)
  const speakLevelRef = useRef(0)
  const isSpeakingRef = useRef(false)

  const isAiResponding = isThinking || pendingText.length > 0

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem("companion_theme", theme)
    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute("content", theme === "dark" ? "#171310" : "#f5f2ec")
  }, [theme])

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
    fetch(`${baseUrl}/history`)
      .then((res) => res.json())
      .then((history: Message[]) => {
        if (messagesRef.current.length === 0) {
          dispatch({ type: "history", messages: history })
        }
      })
      .catch((err) => console.error("Failed to load chat history:", err))
  }, [backendReady])

  const clearAudioQueue = useCallback(() => {
    pendingRef.current = []
    isProcessingRef.current = false
    for (const s of sourcesRef.current) {
      try {
        s.stop()
      } catch {
        // already finished playing
      }
    }
    sourcesRef.current = []
    nextStartTimeRef.current = 0
  }, [])

  const ensurePlaybackContext = useCallback(async () => {
    if (!playbackCtxRef.current || playbackCtxRef.current.state === "closed") {
      playbackCtxRef.current = new AudioContext()
      nextStartTimeRef.current = 0
    }
    const ctx = playbackCtxRef.current
    if (ctx.state === "suspended") {
      await ctx.resume()
    }
    return ctx
  }, [])

  const processNext = useCallback(async () => {
    if (isProcessingRef.current) return
    if (pendingRef.current.length === 0) return

    isProcessingRef.current = true
    const { buffer, index } = pendingRef.current.shift()!

    try {
      const ctx = await ensurePlaybackContext()

      const decoded = await ctx.decodeAudioData(buffer.slice(0))
      const source = ctx.createBufferSource()
      source.buffer = decoded
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.35
      source.connect(analyser)
      analyser.connect(ctx.destination)
      analyserRef.current = analyser
      sourcesRef.current.push(source)

      const now = ctx.currentTime
      const startTime = Math.max(now, nextStartTimeRef.current)
      source.start(startTime)
      nextStartTimeRef.current = startTime + decoded.duration

      const wallStart = Date.now()
      console.log(
        `[audio] chunk ${index}: SCHEDULED at ${wallStart}ms (ctxTime=${startTime.toFixed(3)}, duration=${decoded.duration.toFixed(2)}s, queueGap=${Math.max(0, startTime - now).toFixed(2)}s)`,
      )
      source.onended = () => {
        sourcesRef.current = sourcesRef.current.filter((s) => s !== source)
        console.log(`[audio] chunk ${index}: PLAYED at ${Date.now()}ms (started ${wallStart}ms)`)
      }
    } catch (err) {
      console.error("Audio playback error:", err)
    } finally {
      isProcessingRef.current = false
      processNext()
    }
  }, [ensurePlaybackContext])

  const sendAudio = useCallback((b64: string, index: number) => {
    const binaryStr = atob(b64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }
    console.log(
      `[audio] chunk ${index}: RECEIVED at ${Date.now()}ms (${binaryStr.length} bytes)`,
    )
    pendingRef.current.push({ buffer: bytes.buffer, index })
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
        sendAudio(data.content, data.index)
      }
    }

    return () => ws.close()
  }, [backendReady, sendAudio])

  useEffect(() => {
    const id = setInterval(() => {
      const analyser = analyserRef.current
      if (analyser) {
        const data = new Float32Array(analyser.fftSize)
        analyser.getFloatTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        speakLevelRef.current = Math.sqrt(sum / data.length)
      } else {
        speakLevelRef.current = 0
      }
      isSpeakingRef.current = sourcesRef.current.length > 0
    }, 100)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (mode === "chat") clearAudioQueue()
  }, [mode, clearAudioQueue])

  const handleSendText = useCallback(
    (text: string) => {
      if (!text || !wsRef.current) return

      clearAudioQueue()
      ensurePlaybackContext()

      wsRef.current.send(text)
      dispatch({ type: "send", text })
    },
    [clearAudioQueue, ensurePlaybackContext],
  )

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
          <button
            className="theme-toggle"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
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
          dark={theme === "dark"}
          onSendText={handleSendText}
          clearAudioQueue={clearAudioQueue}
          preparePlayback={ensurePlaybackContext}
          speakLevelRef={speakLevelRef}
          isSpeakingRef={isSpeakingRef}
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