export interface Message {
  role: "human" | "ai"
  content: string
}

export interface TokenMessage {
  type: "token"
  content: string
}

export interface DoneMessage {
  type: "done"
}

export type WebSocketMessage = TokenMessage | DoneMessage
