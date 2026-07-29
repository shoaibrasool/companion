from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from graph import graph
from database import init_db
from load_chat_history import load_chat_history
from langchain_core.messages import HumanMessage
import stt_service
import tts_service
import asyncio
import base64
import re
from concurrent.futures import ThreadPoolExecutor

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

_tts_executor = ThreadPoolExecutor(max_workers=1)

_ABBREVIATIONS = {
    "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.",
    "st.", "ave.", "blvd.", "rd.", "ln.", "dr.",
    "etc.", "vs.", "dept.", "est.", "govt.",
}


def _is_abbreviation(word: str) -> bool:
    return word.lower().rstrip(")") in _ABBREVIATIONS


def _find_split(remaining: str, max_chars: int, min_chars: int) -> int:
    sentence_delims = re.compile(r"(?<=[.!?])\s+")
    clause_delims = re.compile(r"(?<=[,;:])\s+")
    space_delims = re.compile(r"\s+")

    for m in reversed(list(sentence_delims.finditer(remaining))):
        pos = m.start()
        if pos > max_chars:
            continue
        prev_word = remaining[:pos].rstrip().split()[-1] if pos > 0 else ""
        if _is_abbreviation(prev_word):
            continue
        return pos

    for m in reversed(list(clause_delims.finditer(remaining))):
        pos = m.start()
        if pos > max_chars or pos < min_chars:
            continue
        return pos

    for m in reversed(list(space_delims.finditer(remaining))):
        pos = m.start()
        if pos > max_chars or pos < min_chars:
            continue
        return pos

    return min(len(remaining), max(max_chars, min_chars))


def _extract_chunks(text: str, target: int = 55, max_chars: int = 70, min_chars: int = 0) -> list[str]:
    if len(text) <= max_chars:
        return [text]

    chunks = []
    remaining = text

    while len(remaining) > max_chars:
        pos = _find_split(remaining, max_chars, min_chars)
        chunk = remaining[:pos].strip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[pos:].strip()
        if not remaining:
            break

    if remaining:
        chunks.append(remaining)

    return chunks


class OrderedAudioSender:
    def __init__(self, websocket: WebSocket):
        self._ws = websocket
        self._lock = asyncio.Lock()
        self._pending: dict[int, str] = {}
        self._next_index = 0

    async def submit(self, index: int, b64_audio: str):
        async with self._lock:
            self._pending[index] = b64_audio
            while self._next_index in self._pending:
                data = self._pending.pop(self._next_index)
                await self._ws.send_json({
                    "type": "audio",
                    "content": data,
                    "format": "wav",
                })
                self._next_index += 1


def _synthesize_to_b64(text: str) -> str:
    wav_bytes = tts_service.synthesize(text)
    return base64.b64encode(wav_bytes).decode("ascii")


async def _run_tts_task(
    sender: OrderedAudioSender,
    index: int,
    text: str,
):
    print(f"[TTS] chunk {index}: start ({len(text)} chars: {text[:40]}...)", flush=True)
    try:
        loop = asyncio.get_running_loop()
        b64 = await loop.run_in_executor(_tts_executor, _synthesize_to_b64, text)
        await sender.submit(index, b64)
        print(f"[TTS] chunk {index}: done", flush=True)
    except Exception as e:
        print(f"[TTS] chunk {index}: FAILED: {e}", flush=True)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    text = stt_service.transcribe(audio_bytes)
    return {"text": text}


@app.websocket("/ws/{session_id}")
async def chat_websocket(websocket: WebSocket, session_id: str):
    await websocket.accept()
    history_loaded = False
    sender = OrderedAudioSender(websocket)
    tts_tasks: list[asyncio.Task] = []

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

            TARGET = 55
            MAX_CHARS = 70
            MIN_CHARS_FINAL = 25

            full_text = ""
            token_acc = ""
            chunk_index = 0

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

                    if len(token_acc) >= TARGET:
                        acc_chunks = _extract_chunks(token_acc, target=TARGET, max_chars=MAX_CHARS)
                        if acc_chunks:
                            chunk_text = acc_chunks[0]
                            token_acc = token_acc[len(chunk_text):].strip()
                            task = asyncio.create_task(
                                _run_tts_task(sender, chunk_index, chunk_text)
                            )
                            tts_tasks.append(task)
                            chunk_index += 1
                            print(f"[TTS] streaming chunk {chunk_index - 1}: {len(chunk_text)} chars: {chunk_text[:40]}...", flush=True)

            print(f"[TTS] streaming done, full text ({len(full_text)} chars): {full_text[:80]}...", flush=True)

            if not full_text.strip():
                for t in tts_tasks:
                    t.cancel()
                tts_tasks.clear()
                await websocket.send_json({"type": "done"})
                continue

            if token_acc:
                remainder_chunks = _extract_chunks(token_acc, target=TARGET, max_chars=MAX_CHARS, min_chars=MIN_CHARS_FINAL)
                print(f"[TTS] remainder: {len(remainder_chunks)} chunks: {[f'{i}({len(c)})' for i, c in enumerate(remainder_chunks)]}", flush=True)
                for c in remainder_chunks:
                    task = asyncio.create_task(
                        _run_tts_task(sender, chunk_index, c)
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
        pass
