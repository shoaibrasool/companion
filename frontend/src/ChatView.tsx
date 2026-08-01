import { useRef, useCallback, useEffect } from "react"
import type { Message } from "./types"

interface ChatViewProps {
  messages: Message[]
  pendingText: string
  isThinking: boolean
  inputText: string
  onInputChange: (text: string) => void
  onSend: () => void
  isConnected: boolean
}

export default function ChatView({
  messages,
  pendingText,
  isThinking,
  inputText,
  onInputChange,
  onSend,
  isConnected,
}: ChatViewProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "instant" })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, pendingText, scrollToBottom])

  return (
    <>
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
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSend()}
          placeholder={isConnected ? "Type a message..." : "Waiting for connection..."}
          disabled={!isConnected}
        />
        <button onClick={onSend} disabled={!isConnected || !inputText.trim()}>
          Send
        </button>
      </div>
    </>
  )
}