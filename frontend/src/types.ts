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

export interface AudioMessage {
  type: "audio"
  content: string
  format: string
  index: number
}

export type WebSocketMessage = TokenMessage | DoneMessage | AudioMessage
