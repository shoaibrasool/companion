# Companion

A voice-based AI companion built with FastAPI, LangGraph, and a Vite/React frontend. The backend streams LLM tokens over a WebSocket, synthesizes speech with Kokoro (TTS), and transcribes audio with Moonshine (STT).

## Features

- Real-time chat over WebSocket with streaming tokens
- Low-latency streaming text-to-speech (Kokoro ONNX)
- Speech-to-text transcription (Moonshine)
- Chat history persisted to SQLite (SQLAlchemy)
- LangGraph pipeline for LLM + persistence nodes
- Bundled dev runner that starts backend and frontend together

## Architecture

- `main.py` — FastAPI app; WebSocket endpoint (`/ws/{session_id}`), transcription endpoint, ordered streaming TTS sender
- `graph.py` — LangGraph state graph (`llm_node` -> `persist_data_node`)
- `llm_node.py` — streams tokens from Google Gemini (`gemini-3.1-flash-lite`) into the graph stream
- `stt_service.py` — Moonshine ASR model (resamples to 16 kHz)
- `tts_service.py` — Kokoro ONNX TTS, WAV output
- `database.py` / `persist_data.py` — SQLite persistence for chat history
- `load_chat_history.py` — loads prior messages at session start
- `run.py` — starts uvicorn (port 8000) and the Vite dev server (port 5173)
- `frontend/` — Vite + React client

## Prerequisites

- Python 3.10+
- Node.js + npm
- Google API key (Gemini) in `.env`:

```
GOOGLE_API_KEY=your_key_here
```

## Setup

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Place TTS model files in `models/` (expected names):

```
models/kokoro-v1.0.onnx
models/voices-v1.0.bin
```

## Running

```bash
python run.py
```

Or run separately:

```bash
uvicorn main:app --reload --port 8000   # backend
cd frontend && npm install && npm run dev  # frontend
```

- Frontend: http://localhost:5173
- Backend: http://localhost:8000
- Health check: http://localhost:8000/health

## API

| Method | Path                | Description                           |
|--------|---------------------|---------------------------------------|
| GET    | `/health`           | Health check                          |
| POST   | `/transcribe`       | Upload audio file, returns text       |
| WS     | `/ws/{session_id}`  | Chat stream (tokens + audio + done)   |

WebSocket messages from the server:

- `{"type": "token", "content": "<text>"}` — streamed LLM tokens
- `{"type": "audio", "content": "<base64 wav>", "format": "wav", "index": n}` — TTS audio chunk
- `{"type": "done"}` — end of a response
