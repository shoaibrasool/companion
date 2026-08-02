import io
import numpy as np
import soundfile as sf
from transformers import AutoProcessor, MoonshineForConditionalGeneration

_model = None
_processor = None

def load_model():
    global _model, _processor
    _processor = AutoProcessor.from_pretrained("UsefulSensors/moonshine-base")
    _model = MoonshineForConditionalGeneration.from_pretrained(
        "UsefulSensors/moonshine-base"
    )
    _model.eval()

def transcribe(audio_bytes: bytes) -> str:
    if _model is None or _processor is None:
        raise RuntimeError("STT model not loaded. Call load_model() first.")

    audio, sr = sf.read(io.BytesIO(audio_bytes))

    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)

    if sr != 16000:
        import torch
        import torchaudio.functional as F
        audio_t = torch.from_numpy(audio).float().unsqueeze(0)
        audio_t = F.resample(audio_t, sr, 16000)
        audio = audio_t.squeeze().numpy()
        sr = 16000

    inputs = _processor(audio, return_tensors="pt", sampling_rate=sr)
    generated_ids = _model.generate(**inputs, max_new_tokens=200)
    transcription = _processor.batch_decode(
        generated_ids, skip_special_tokens=True
    )[0]
    return transcription.strip()
