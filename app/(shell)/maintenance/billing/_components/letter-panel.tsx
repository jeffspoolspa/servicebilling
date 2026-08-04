"use client"

import { useState } from "react"

/**
 * Customer-letter panel — replaces the AI bill analysis in the workbench.
 * The reviewer seeds the draft with their own framing (modal), reads it,
 * iterates with follow-up instructions (the thread goes back to the model so
 * it refines rather than restarts), then prints to PDF to accompany the
 * invoice. Drafts persist server-side (billing.customer_letters).
 */

export interface InitialLetter {
  letter: string
  reviewer_context: string | null
  updated_at: string
}

async function pollJob(pollUrl: string, timeoutMs = 120000): Promise<{ letter: string }> {
  const t0 = Date.now()
  for (;;) {
    const r = await fetch(pollUrl)
    const j = await r.json()
    if (j.completed) {
      if (j.success === false || j.result?.error) throw new Error(j.result?.error?.message ?? "draft failed")
      return j.result
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for the draft")
    await new Promise((res) => setTimeout(res, 2000))
  }
}

export function LetterPanel({
  customerId,
  customerName,
  month,
  monthLabel,
  initial = null,
}: {
  customerId: number
  customerName: string
  month: string // 'YYYY-MM'
  monthLabel: string
  initial?: InitialLetter | null
}) {
  const [letter, setLetter] = useState<string | null>(initial?.letter ?? null)
  const [context, setContext] = useState(initial?.reviewer_context ?? "")
  const [thread, setThread] = useState<{ role: "user" | "assistant"; text: string }[]>(
    initial ? [{ role: "assistant", text: initial.letter }] : [],
  )
  const [modalOpen, setModalOpen] = useState(false)
  const [followUp, setFollowUp] = useState("")
  const [drafting, setDrafting] = useState(false)
  const [err, setErr] = useState("")

  async function draft(nextThread: { role: "user" | "assistant"; text: string }[]) {
    setDrafting(true)
    setErr("")
    try {
      const r = await fetch("/api/billing/letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: customerId, month, context, thread: nextThread }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? "draft trigger failed")
      const result = await pollJob(`/api/billing/letter?job=${j.jobId}`)
      setLetter(result.letter)
      setThread([...nextThread, { role: "assistant", text: result.letter }])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setDrafting(false)
    }
  }

  function startDraft() {
    setModalOpen(false)
    void draft([])
  }

  function iterate() {
    if (!followUp.trim()) return
    const next = [...thread, { role: "user" as const, text: followUp.trim() }]
    setFollowUp("")
    void draft(next)
  }

  // Print-to-PDF: a print-styled window; the browser's Save-as-PDF is the PDF.
  function printLetter() {
    if (!letter) return
    const w = window.open("", "_blank", "width=700,height=900")
    if (!w) return
    const paragraphs = letter.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`).join("")
    w.document.write(`<!doctype html><html><head><title>${customerName} — ${monthLabel}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #1c1c1a; max-width: 620px;
         margin: 48px auto; line-height: 1.65; font-size: 14.5px; }
  header { margin-bottom: 32px; }
  .co { font-size: 17px; font-weight: 700; letter-spacing: 0.02em; }
  .meta { font-size: 12px; color: #6b6b66; margin-top: 4px; }
  p { margin: 0 0 14px; }
  @media print { body { margin: 24px auto; } }
</style></head><body>
<header><div class="co">Jeff's Pool &amp; Spa Service</div>
<div class="meta">${customerName} · ${monthLabel}</div></header>
${paragraphs}
</body></html>`)
    w.document.close()
    w.focus()
    w.print()
  }

  return (
    <div className="bg-bg border border-line rounded-xl overflow-hidden flex-none">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line-soft">
        <span className="font-display text-[15px]">Customer letter</span>
        <div className="flex-1" />
        {letter && !drafting && (
          <button
            onClick={printLetter}
            className="h-6 px-2.5 rounded-md border border-line bg-bg-elev text-ink-dim text-[10.5px] hover:border-teal hover:text-teal"
          >
            Print / PDF
          </button>
        )}
        <button
          onClick={() => setModalOpen(true)}
          disabled={drafting}
          className={
            letter
              ? "h-6 px-2.5 rounded-md border border-line bg-bg-elev text-ink-dim text-[10.5px] hover:border-cyan hover:text-cyan disabled:opacity-50"
              : "h-7 px-3 rounded-lg bg-gradient-to-b from-cyan to-cyan-deep text-bg text-[12px] font-semibold hover:brightness-110 disabled:opacity-50"
          }
        >
          {drafting ? "Drafting…" : letter ? "Restart" : "Draft letter"}
        </button>
      </div>

      {drafting && (
        <div className="px-4 py-3 flex items-center gap-2.5 text-[12px] text-cyan">
          <span className="inline-block w-3 h-3 rounded-full border-2 border-cyan/25 border-t-cyan animate-spin" />
          Writing from the month&apos;s visits, items, and findings…
        </div>
      )}
      {err && !drafting && <div className="px-4 py-3 text-[12px] text-coral">{err}</div>}
      {!letter && !drafting && !err && (
        <div className="px-4 py-3 text-[12px] text-ink-mute leading-relaxed">
          Drafts a customer-facing letter explaining this bill from the service-log
          evidence. You seed it with your framing, iterate until it reads right, then
          print to PDF — it goes out with the invoice.
        </div>
      )}
      {letter && !drafting && (
        <div className="px-4 py-3 flex flex-col gap-3">
          <div className="text-[12.5px] leading-relaxed text-ink whitespace-pre-wrap max-h-[300px] overflow-y-auto">
            {letter}
          </div>
          <div className="flex gap-2">
            <input
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && iterate()}
              placeholder="Refine: e.g. mention the storm, soften the tone, add the discount"
              className="flex-1 h-8 px-2.5 rounded-md border border-line bg-bg-elev text-[12px] text-ink placeholder:text-ink-mute focus:border-cyan outline-none"
            />
            <button
              onClick={iterate}
              disabled={!followUp.trim()}
              className="h-8 px-3 rounded-md border border-line bg-bg-elev text-[11.5px] text-ink-dim hover:border-cyan hover:text-cyan disabled:opacity-40"
            >
              Revise
            </button>
          </div>
        </div>
      )}

      {/* context modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setModalOpen(false)}>
          <div
            className="w-[520px] max-w-[92vw] rounded-xl border border-line bg-bg-surface p-5 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-display text-[15px]">Your framing for the letter</div>
            <div className="text-[12px] text-ink-mute leading-relaxed">
              What should the letter say? The model has the visits, items, and flags —
              give it what it can&apos;t know: the cause, the conversation, any discount.
            </div>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={5}
              autoFocus
              placeholder="e.g. Pool went green after the July storms while they were out of town — we shocked it twice. Applying a 10% chem discount as a goodwill gesture."
              className="w-full rounded-md border border-line bg-bg-elev p-2.5 text-[12.5px] text-ink placeholder:text-ink-mute focus:border-cyan outline-none resize-y"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setModalOpen(false)}
                className="h-8 px-3 rounded-md border border-line text-[12px] text-ink-dim hover:border-ink-dim"
              >
                Cancel
              </button>
              <button
                onClick={startDraft}
                className="h-8 px-3.5 rounded-md bg-gradient-to-b from-cyan to-cyan-deep text-bg text-[12px] font-semibold hover:brightness-110"
              >
                Draft
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
