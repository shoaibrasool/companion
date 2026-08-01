import { useState, useRef, useCallback, useEffect } from "react"
import type { RefObject } from "react"
import VoiceButton from "./VoiceButton"
import type { OrbStatus } from "./VoiceButton"

interface VoiceViewProps {
  isConnected: boolean
  isAiResponding: boolean
  dark: boolean
  onSendText: (text: string) => void
  clearAudioQueue: () => void
  preparePlayback: () => Promise<unknown>
  speakLevelRef: RefObject<number>
  isSpeakingRef: RefObject<boolean>
}

const TARGET_SR = 16000

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = samples.length * (bitsPerSample / 8)
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
  }
  w(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  w(8, "WAVE")
  w(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  w(36, "data")
  view.setUint32(40, dataSize, true)

  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return new Blob([buffer], { type: "audio/wav" })
}

export default function VoiceView({
  isConnected,
  isAiResponding,
  dark,
  onSendText,
  clearAudioQueue,
  preparePlayback,
  speakLevelRef,
  isSpeakingRef,
}: VoiceViewProps) {
  const [status, setStatus] = useState<OrbStatus>("idle")

  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const micLevelRef = useRef(0)

  useEffect(() => {
    if (status === "waiting" && !isAiResponding) {
      setStatus("idle")
    }
  }, [isAiResponding, status])

  const startRecording = useCallback(async () => {
    try {
      preparePlayback()

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioCtx = new AudioContext({ sampleRate: TARGET_SR })
      audioCtxRef.current = audioCtx

      const source = audioCtx.createMediaStreamSource(stream)
      sourceRef.current = source

      const processor = audioCtx.createScriptProcessor(4096, 1, 1)
      processorRef.current = processor

      chunksRef.current = []

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        const data = e.inputBuffer.getChannelData(0)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        const rms = Math.sqrt(sum / data.length)
        micLevelRef.current = micLevelRef.current * 0.6 + rms * 0.4
        chunksRef.current.push(new Float32Array(data))
      }

      source.connect(processor)
      processor.connect(audioCtx.destination)

      setStatus("recording")
    } catch (err) {
      console.error("Mic access denied:", err)
      setStatus("idle")
    }
  }, [preparePlayback])

  const stopRecording = useCallback(async () => {
    micLevelRef.current = 0
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    audioCtxRef.current?.close()

    streamRef.current?.getTracks().forEach((t) => t.stop())

    const totalLen = chunksRef.current.reduce((s, a) => s + a.length, 0)
    const combined = new Float32Array(totalLen)
    let offset = 0
    for (const arr of chunksRef.current) {
      combined.set(arr, offset)
      offset += arr.length
    }

    setStatus("transcribing")

    if (combined.length === 0) {
      setStatus("idle")
      return
    }

    clearAudioQueue()

    const wavBlob = encodeWav(combined, TARGET_SR)
    const formData = new FormData()
    formData.append("file", wavBlob, "recording.wav")

    try {
      const baseUrl = import.meta.env.VITE_API_URL || "http://localhost:8000"
      const res = await fetch(`${baseUrl}/transcribe`, {
        method: "POST",
        body: formData,
      })
      if (!res.ok) throw new Error(`Transcribe failed: ${res.statusText}`)
      const data = await res.json()
      const text: string = data.text
      if (text) {
        setStatus("waiting")
        onSendText(text)
      } else {
        setStatus("idle")
      }
    } catch (err) {
      console.error("Transcription error:", err)
      setStatus("idle")
    }
  }, [clearAudioQueue, onSendText])

  const statusText = () => {
    switch (status) {
      case "idle":
        return "Hold to speak"
      case "recording":
        return "Listening..."
      case "transcribing":
        return "Transcribing..."
      case "waiting":
        return "Waiting for response..."
    }
  }

  return (
    <div className="voice-view">
      <div
        className={`orb-wrap ${isConnected ? "" : "disabled"}`}
        role="button"
        tabIndex={0}
        aria-label={status === "recording" ? "Stop recording" : "Hold to speak"}
        onPointerDown={(e) => {
          e.preventDefault()
          if (isConnected && status === "idle") startRecording()
        }}
        onPointerUp={() => {
          if (status === "recording") stopRecording()
        }}
        onPointerLeave={() => {
          if (status === "recording") stopRecording()
        }}
        onPointerCancel={() => {
          if (status === "recording") stopRecording()
        }}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault()
            if (isConnected && status === "idle") startRecording()
            else if (status === "recording") stopRecording()
          }
        }}
      >
        <VoiceButton
          status={status}
          dark={dark}
          micLevelRef={micLevelRef}
          speakLevelRef={speakLevelRef}
          isSpeakingRef={isSpeakingRef}
        />
      </div>
      <p className="voice-status">{statusText()}</p>
    </div>
  )
}
