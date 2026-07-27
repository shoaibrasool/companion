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

  const wsRef = useRef<WebSocket | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

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
            isConnected ? "Type a message..." : "Waiting for connection..."
          }
          disabled={!isConnected}
        />
        <button onClick={sendMessage} disabled={!isConnected || !inputText.trim()}>
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
