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
import time
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

# Mirrors the standalone TTS pipeline: split after ., !, ?, ,, ; while
# keeping the punctuation attached to the preceding chunk.
_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?,;]) +")

_MAX_CHARS = 70
_MIN_FLUSH_CHARS = 3


def _is_abbreviation(word: str) -> bool:
    return word.lower().rstrip(")") in _ABBREVIATIONS


def _split_ready_chunks(buffer: str) -> tuple[str, list[str]]:
    """Pop completed sentences out of the streaming token buffer.

    Returns (remaining_buffer, ready_chunks). A sentence is ready as soon
    as its punctuation is followed by whitespace, so chunks are dispatched
    to TTS the moment they exist instead of waiting for an accumulation
    target.
    """
    ready: list[str] = []
    remaining = buffer
    while True:
        valid = None
        for m in _SENTENCE_BOUNDARY.finditer(remaining):
            prev = remaining[:m.start()].rstrip()
            if prev and _is_abbreviation(prev.split()[-1]):
                continue
            valid = m
            break
        if valid is None:
            break
        chunk = remaining[:valid.start()].strip()
        if chunk:
            ready.append(chunk)
        remaining = remaining[valid.end():].lstrip()
    return remaining, ready


def _hard_split(text: str, max_chars: int) -> tuple[str, list[str]]:
    """Fallback for one long sentence with no punctuation boundary."""
    ready: list[str] = []
    remaining = text
    while len(remaining) > max_chars:
        pos = remaining.rfind(" ", 0, max_chars)
        if pos <= max_chars // 2:
            pos = max_chars
        ready.append(remaining[:pos].strip())
        remaining = remaining[pos:].strip()
    return remaining, ready


class OrderedAudioSender:
    """Audio chunks are produced by TTS tasks and sent in index order by a
    single owner task, so one failing chunk can never stall the rest."""

    def __init__(self):
        self._queue: asyncio.Queue[tuple[int, str]] = asyncio.Queue()
        self._pending: dict[int, str] = {}
        self._next_index = 0

    async def run(self, websocket: WebSocket):
        while True:
            index, b64 = await self._queue.get()
            if index < self._next_index:
                print(
                    f"[TTS] chunk {index}: STALE DROP (next expected {self._next_index})",
                    flush=True,
                )
                continue
            self._pending[index] = b64
            while self._next_index in self._pending:
                data = self._pending.pop(self._next_index)
                try:
                    await websocket.send_json({
                        "type": "audio",
                        "content": data,
                        "format": "wav",
                        "index": self._next_index,
                    })
                except Exception as e:
                    print(
                        f"[TTS] chunk {self._next_index}: SEND FAILED: {e} (skipped)",
                        flush=True,
                    )
                else:
                    print(
                        f"[TTS] chunk {self._next_index}: SENT at {time.time():.3f}s",
                        flush=True,
                    )
                self._next_index += 1

    async def submit(self, index: int, b64_audio: str):
        await self._queue.put((index, b64_audio))


def _synthesize_to_b64(text: str) -> str:
    wav_bytes = tts_service.synthesize(text)
    return base64.b64encode(wav_bytes).decode("ascii")


async def _run_tts_task(
    sender: OrderedAudioSender,
    index: int,
    text: str,
):
    t_start = time.perf_counter()
    print(
        f"[TTS] chunk {index}: DISPATCH at {time.time():.3f}s ({len(text)} chars: {text[:40]}...)",
        flush=True,
    )
    try:
        loop = asyncio.get_running_loop()
        b64 = await loop.run_in_executor(_tts_executor, _synthesize_to_b64, text)
        print(
            f"[TTS] chunk {index}: GENERATED at {time.time():.3f}s (synth took {time.perf_counter() - t_start:.2f}s)",
            flush=True,
        )
        await sender.submit(index, b64)
        print(
            f"[TTS] chunk {index}: QUEUED at {time.time():.3f}s",
            flush=True,
        )
    except asyncio.CancelledError:
        print(f"[TTS] chunk {index}: CANCELLED", flush=True)
        raise
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

                    token_acc, ready = _split_ready_chunks(token_acc)
                    if len(token_acc) > _MAX_CHARS:
                        token_acc, hard = _hard_split(token_acc, _MAX_CHARS)
                        ready.extend(hard)

                    for c in ready:
                        task = asyncio.create_task(
                            _run_tts_task(sender, chunk_index, c)
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

            if len(token_acc) > _MAX_CHARS:
                token_acc, hard = _hard_split(token_acc, _MAX_CHARS)
                for c in hard:
                    task = asyncio.create_task(
                        _run_tts_task(sender, chunk_index, c)
                    )
                    tts_tasks.append(task)
                    chunk_index += 1

            remainder = token_acc.strip()
            if len(remainder) >= _MIN_FLUSH_CHARS:
                task = asyncio.create_task(
                    _run_tts_task(sender, chunk_index, remainder)
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
