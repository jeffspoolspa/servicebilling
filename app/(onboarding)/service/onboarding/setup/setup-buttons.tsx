"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { runCalendlySetup, runGoogleCheck, runTickNow, type SetupResult } from "./actions"

export function SetupButtons() {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [result, setResult] = useState<SetupResult | null>(null)
  const run = (fn: () => Promise<SetupResult>) =>
    start(async () => {
      setResult(null)
      setResult(await fn())
      router.refresh()
    })
  return (
    <section className="bg-bg-elev border border-line rounded-lg p-5">
      <h2 className="font-display text-[15px] mb-3">Actions</h2>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run(runGoogleCheck)} disabled={pending}>Check Gmail + Drive</Button>
        <Button onClick={() => run(runCalendlySetup)} disabled={pending}>Connect Calendly</Button>
        <Button onClick={() => run(runTickNow)} disabled={pending}>Run tick now</Button>
      </div>
      {pending && <p className="text-[12px] text-ink-mute mt-3">Working…</p>}
      {result && (
        <div className={`mt-3 text-[13px] ${result.ok ? "text-grass" : "text-coral"}`}>
          {result.message}
          {result.detail !== undefined && (
            <pre className="mt-2 text-[11px] text-ink-dim bg-black/20 rounded p-2 overflow-x-auto">{JSON.stringify(result.detail, null, 2)}</pre>
          )}
        </div>
      )}
    </section>
  )
}
