"use client"

import { useRef, useState } from "react"
import { Mic, Square, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils/cn"

interface Props {
  customer: string
  issue: string
  onResult: (text: string) => void
}

type State = "idle" | "recording" | "transcribing"

/**
 * Records raw audio (MediaRecorder) and sends it to /api/transcribe, which
 * transcribes with pool-service context and returns cleaned notes. Bypasses the
 * device's own dictation entirely — see the route for why.
 */
export function VoiceNote({ customer, issue, onResult }: Props) {
  const [state, setState] = useState<State>("idle")
  const [error, setError] = useState<string | null>(null)
  const [secs, setSecs] = useState(0)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function start() {
    setError(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError("Microphone access denied.")
      return
    }
    chunksRef.current = []
    const rec = new MediaRecorder(stream)
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data)
    }
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      if (timerRef.current) clearInterval(timerRef.current)
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" })
      await transcribe(blob)
    }
    recRef.current = rec
    rec.start()
    setState("recording")
    setSecs(0)
    timerRef.current = setInterval(() => setSecs((s) => s + 1), 1000)
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

  return (
    <div className="flex flex-col gap-1.5">
      {state === "idle" && (
        <button
          type="button"
          onClick={start}
          className={cn(
            "self-start inline-flex items-center gap-2 h-9 px-3.5 rounded-lg text-sm",
            "border border-cyan/30 bg-cyan/[0.06] text-cyan",
            "transition-[background-color,transform] duration-150 ease-out",
            "hover:bg-cyan/10 active:scale-[0.98]",
          )}
        >
          <Mic className="w-4 h-4" strokeWidth={2} /> Voice note
        </button>
      )}
      {state === "recording" && (
        <button
          type="button"
          onClick={stop}
          className={cn(
            "self-start inline-flex items-center gap-2 h-9 px-3.5 rounded-lg text-sm",
            "border border-coral/40 bg-coral/10 text-coral animate-pulse",
            "transition-transform duration-150 active:scale-[0.98]",
          )}
        >
          <Square className="w-3.5 h-3.5 fill-current" strokeWidth={2} /> Stop · {clock}
        </button>
      )}
      {state === "transcribing" && (
        <div className="self-start inline-flex items-center gap-2 h-9 px-3.5 text-sm text-ink-dim">
          <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2} /> Transcribing…
        </div>
      )}
      {error && <p className="text-coral text-xs">{error}</p>}
    </div>
  )
}
