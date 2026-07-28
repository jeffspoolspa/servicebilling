import { Pill } from "@/components/ui/pill"
import type { InvoiceStreamEvent } from "@/lib/queries/dashboard"

/**
 * Live "this invoice is being worked on right now" indicator.
 *
 * Derived from the queue lifecycle events, not from a status column — a stage
 * is IN FLIGHT when its last lifecycle event is `processing_claimed` with no
 * `processing_finished` or `processing_failed` after it.
 *
 * That derivation is only trustworthy because of where those events come from:
 * `claimed` is written by the queue trigger the instant a worker takes the row,
 * and `finished` is emitted by the worker itself as its last act, so "claimed
 * with nothing after it" genuinely means a script is mid-run. (When `finished`
 * came from the queue trigger it did NOT mean that — the row was closed after
 * the run, and the next stage's enqueue had already landed in between.)
 *
 * Goes live for free: the page subscribes to billing.events, so an arriving
 * event re-renders the server component and this pill appears/disappears
 * without a refresh.
 */

const STAGE_LABEL: Record<string, string> = {
  preprocess: "pre-processing",
  charge: "processing",
}

export function ProcessingPill({ stream }: { stream: InvoiceStreamEvent[] }) {
  // last lifecycle event per stage — the stream is ordered by seq
  const lastByStage = new Map<string, InvoiceStreamEvent>()
  for (const e of stream) {
    if (
      e.type === "processing_claimed" ||
      e.type === "processing_finished" ||
      e.type === "processing_failed"
    ) {
      const stage = (e.payload as { stage?: string })?.stage ?? "preprocess"
      const prev = lastByStage.get(stage)
      if (!prev || e.seq > prev.seq) lastByStage.set(stage, e)
    }
  }

  // A run that died mid-flight leaves `claimed` with nothing after it and no
  // queue row to reconstruct from, so "claimed" alone would pulse forever.
  // A drain is seconds; anything older than this is not running, it is stuck —
  // and a stuck run is the queue's problem (attempts / dead-letter), not
  // something to advertise as in-progress.
  const STALE_AFTER_MS = 5 * 60 * 1000

  const running = [...lastByStage.entries()].find(
    ([, e]) =>
      e.type === "processing_claimed" &&
      Date.now() - new Date(e.occurred_at).getTime() < STALE_AFTER_MS,
  )
  if (!running) return null

  const [stage] = running
  return (
    <Pill tone="cyan" dot>
      <span className="animate-pulse">{STAGE_LABEL[stage] ?? stage}…</span>
    </Pill>
  )
}
