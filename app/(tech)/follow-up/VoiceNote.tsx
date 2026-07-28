"use client"

import { useEffect, useRef, useState } from "react"
import { Mic, Square, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils/cn"

interface Props {
  customer: string
  issue: string
  onResult: (text: string) => void
}

type State = "idle" | "recording" | "transcribing"

const BARS = 9 // equalizer bars in the recording indicator

/**
 * Records raw audio (MediaRecorder) and sends it to /api/transcribe, which
 * transcribes with pool-service context and returns cleaned notes. Bypasses the
 * device's own dictation entirely — see the route for why.
 *
 * Renders icon-first so it can sit inside the description composer. While
 * recording it shows a live equalizer driven by the real mic level (Web Audio
 * AnalyserNode) so the tech can see it's picking up sound.
 */
export function VoiceNote({ customer, issue, onResult }: Props) {
  const [state, setState] = useState<State>("idle")
  const [error, setError] = useState<string | null>(null)
  const [secs, setSecs] = useState(0)
  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Live-level plumbing. Bars are mutated directly (style.transform) in the rAF
  // loop — never via React state — so we don't re-render 60×/sec.
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const barsRef = useRef<(HTMLSpanElement | null)[]>([])

  function teardownAudio() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
  }

  // Unmounting mid-recording (form cleared, tab switched) never fires stop()/onstop,
  // so release the mic, audio graph, and timer directly here.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (timerRef.current) clearInterval(timerRef.current)
      teardownAudio()
    },
    [],
  )

  function startMeter(stream: MediaStream) {
    // AudioContext = the browser's audio-processing graph. We tap the mic stream
    // into an AnalyserNode (gives us live frequency magnitudes) but never connect
    // it to the speakers, so there's no playback/feedback.
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    audioCtxRef.current = ctx
    void ctx.resume() // iOS starts it suspended until a user gesture (this is one)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 64
    analyser.smoothingTimeConstant = 0.75
    ctx.createMediaStreamSource(stream).connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteFrequencyData(data)
      for (let i = 0; i < BARS; i++) {
        // Spread the bars across the lower/mid bins where voice energy lives.
        const v = data[1 + i] / 255 // 0..1
        const bar = barsRef.current[i]
        if (bar) bar.style.transform = `scaleY(${(0.12 + v * 0.88).toFixed(3)})`
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    tick()
  }

  async function start() {
    setError(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError("Microphone access denied.")
      return
    }
    streamRef.current = stream
    chunksRef.current = []
    const rec = new MediaRecorder(stream)
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data)
    }
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      if (timerRef.current) clearInterval(timerRef.current)
      teardownAudio()
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" })
      await transcribe(blob)
    }
    recRef.current = rec
    rec.start()
    setState("recording")
    setSecs(0)
    timerRef.current = setInterval(() => setSecs((s) => s + 1), 1000)
    startMeter(stream)
  }

  function stop() {
    recRef.current?.stop()
    setState("transcribing")
  }

  async function transcribe(blob: Blob) {
    try {
      const fd = new FormData()
      fd.append("audio", blob, "note")
      fd.append("customer", customer)
      fd.append("issue", issue)
      const resp = await fetch("/api/transcribe", { method: "POST", body: fd })
      const data = (await resp.json()) as { text?: string; error?: string }
      if (!resp.ok) throw new Error(data.error || "Transcription failed.")
      if (data.text) onResult(data.text)
      setState("idle")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transcription failed.")
      setState("idle")
    }
  }

  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`

  if (state === "recording") {
    return (
      <div className="inline-flex items-center gap-2 h-8 pl-2 pr-1 rounded-full border border-coral/40 bg-coral/10">
        <div className="flex items-end gap-[2px] h-4">
          {Array.from({ length: BARS }).map((_, i) => (
            <span
              key={i}
              ref={(el) => {
                barsRef.current[i] = el
              }}
              className="w-[2px] h-4 rounded-full bg-coral origin-center"
              style={{ transform: "scaleY(0.12)" }}
            />
          ))}
        </div>
        <span className="text-xs text-coral tabular-nums w-8 text-center">{clock}</span>
        <button
          type="button"
          onClick={stop}
          aria-label="Stop recording"
          className="w-6 h-6 grid place-items-center rounded-full bg-coral text-white active:scale-90"
        >
          <Square className="w-3 h-3 fill-current" strokeWidth={2} />
        </button>
      </div>
    )
  }

  return (
    <div className="inline-flex items-center gap-2">
      {state === "transcribing" ? (
        <div className="inline-flex items-center gap-1.5 h-8 px-2 text-xs text-ink-dim">
          <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2} /> Transcribing…
        </div>
      ) : (
        <button
          type="button"
          onClick={start}
          aria-label="Record a voice note"
          className={cn(
            "w-8 h-8 grid place-items-center rounded-full",
            "text-cyan hover:bg-cyan/10 active:scale-90",
            "transition-[background-color,transform] duration-150 ease-out",
          )}
        >
          <Mic className="w-4 h-4" strokeWidth={2} />
        </button>
      )}
      {error && <span className="text-coral text-xs">{error}</span>}
    </div>
  )
}
