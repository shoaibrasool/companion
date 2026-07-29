from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from graph import graph
from database import init_db
from load_chat_history import load_chat_history
from langchain_core.messages import HumanMessage


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.websocket("/ws/{session_id}")
async def chat_websocket(websocket: WebSocket, session_id: str):
    await websocket.accept()
    history_loaded = False

    try:
        while True:
            user_text = await websocket.receive_text()

            msg = HumanMessage(content=user_text)

            if not history_loaded:
                history = load_chat_history()
                input_state = {"messages": history + [msg]}
                history_loaded = True
            else:
                input_state = {"messages": [msg]}

            async for chunk in graph.astream(
                input_state,
                stream_mode="custom",
                version="v2",
            ):
                if chunk["type"] == "custom":
                    await websocket.send_json({
                        "type": "token",
                        "content": chunk["data"]["content"],
                    })

            await websocket.send_json({"type": "done"})

    except WebSocketDisconnect:
        pass
