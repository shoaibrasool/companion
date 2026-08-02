import io

import soundfile as sf
from kokoro_onnx import Kokoro

from backend.core.config import MODELS_DIR

_kokoro = None


def load_model():
    global _kokoro
    onnx_path = MODELS_DIR / "kokoro-v1.0.onnx"
    voices_path = MODELS_DIR / "voices-v1.0.bin"
    _kokoro = Kokoro(onnx_path, voices_path)

def synthesize(text: str) -> bytes:
    if _kokoro is None:
        raise RuntimeError("TTS model not loaded. Call load_model() first.")
    samples, sample_rate = _kokoro.create(
        text, voice="af_heart", speed=1.0, lang="en-us"
    )
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="wav")
    buf.seek(0)
    return buf.read()
