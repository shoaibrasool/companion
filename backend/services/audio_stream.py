import asyncio
import base64
import re
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import WebSocket

import backend.services.tts as tts_service

_tts_executor = ThreadPoolExecutor(max_workers=1)

_ABBREVIATIONS = {
    "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.",
    "st.", "ave.", "blvd.", "rd.", "ln.", "dr.",
    "etc.", "vs.", "dept.", "est.", "govt.",
}

# Mirrors the standalone TTS pipeline: split after ., !, ?, ,, ; while
# keeping the punctuation attached to the preceding chunk.
_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?,;]) +")

MAX_CHARS = 70
MIN_FLUSH_CHARS = 3


def _is_abbreviation(word: str) -> bool:
    return word.lower().rstrip(")") in _ABBREVIATIONS


def split_ready_chunks(buffer: str) -> tuple[str, list[str]]:
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


def hard_split(text: str, max_chars: int) -> tuple[str, list[str]]:
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


async def run_tts_task(
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
