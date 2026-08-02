import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage

import backend.services.stt as stt_service
import backend.services.tts as tts_service
from backend.agent.graph import graph
from backend.core.chat_history import load_chat_history
from backend.core.db import Message, SessionLocal, init_db
from backend.services.audio_stream import (
    MAX_CHARS,
    MIN_FLUSH_CHARS,
    OrderedAudioSender,
    hard_split,
    run_tts_task,
    split_ready_chunks,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    stt_service.load_model()
    tts_service.load_model()
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/history")
async def history():
    db = SessionLocal()
    try:
        db_messages_inverse = db.query(Message).order_by(Message.created_at.desc(), Message.id.desc()).limit(30).all()
        db_messages = list(reversed(db_messages_inverse))
        return [
            {"role": msg.role, "content": msg.content}
            for msg in db_messages
            if msg.role in ("human", "ai")
        ]
    finally:
        db.close()


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    text = stt_service.transcribe(audio_bytes)
    return {"text": text}


@app.websocket("/ws/{session_id}")
async def chat_websocket(websocket: WebSocket, session_id: str):
    await websocket.accept()
    history_loaded = False
    sender = OrderedAudioSender()
    sender_task = asyncio.create_task(sender.run(websocket))
    tts_tasks: list[asyncio.Task] = []
    chunk_index = 0

    try:
        while True:
            user_text = await websocket.receive_text()

            for t in tts_tasks:
                t.cancel()
            tts_tasks.clear()

            msg = HumanMessage(content=user_text)

            if not history_loaded:
                history = load_chat_history()
                input_state = {"messages": history + [msg]}
                history_loaded = True
            else:
                input_state = {"messages": [msg]}

            full_text = ""
            token_acc = ""

            async for chunk in graph.astream(
                input_state,
                stream_mode="custom",
                version="v2",
            ):
                if chunk["type"] == "custom":
                    content = chunk["data"]["content"]
                    full_text += content
                    token_acc += content
                    await websocket.send_json({
                        "type": "token",
                        "content": content,
                    })

                    token_acc, ready = split_ready_chunks(token_acc)
                    if len(token_acc) > MAX_CHARS:
                        token_acc, hard = hard_split(token_acc, MAX_CHARS)
                        ready.extend(hard)

                    for c in ready:
                        task = asyncio.create_task(
                            run_tts_task(sender, chunk_index, c)
                        )
                        tts_tasks.append(task)
                        chunk_index += 1

            print(f"[TTS] streaming done, full text ({len(full_text)} chars): {full_text[:80]}...", flush=True)

            if not full_text.strip():
                for t in tts_tasks:
                    t.cancel()
                tts_tasks.clear()
                await websocket.send_json({"type": "done"})
                continue

            if len(token_acc) > MAX_CHARS:
                token_acc, hard = hard_split(token_acc, MAX_CHARS)
                for c in hard:
                    task = asyncio.create_task(
                        run_tts_task(sender, chunk_index, c)
                    )
                    tts_tasks.append(task)
                    chunk_index += 1

            remainder = token_acc.strip()
            if len(remainder) >= MIN_FLUSH_CHARS:
                task = asyncio.create_task(
                    run_tts_task(sender, chunk_index, remainder)
                )
                tts_tasks.append(task)
                chunk_index += 1

            if tts_tasks:
                done_tasks, _ = await asyncio.wait(tts_tasks)
                print(f"[TTS] all {len(done_tasks)} chunks finished", flush=True)

            await websocket.send_json({"type": "done"})

    except WebSocketDisconnect:
        for t in tts_tasks:
            t.cancel()
    finally:
        sender_task.cancel()
