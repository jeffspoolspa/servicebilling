"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Pause, Play } from "lucide-react"
import { useCanWrite } from "@/components/providers/access-provider"

/**
 * Place / release a manual hold on this work order.
 *
 * Replaced Skip, which set a flag on the WO row that hid it from queues and
 * left no trace of who decided or why. A hold is a row in billing.holds: the
 * gate refuses to transact while one is open (billing.invoice_on_hold reads
 * holds on the invoice OR its WO), and placing and releasing each emit an
 * event, so the reason lands in the invoice's history either way.
 *
 * Always subjects the WORK ORDER — it exists before the invoice does, and it
 * keeps holding if the invoice number changes.
 */
export function HoldButton({
  woNumber,
  held,
  holdReason,
}: {
  woNumber: string
  held: boolean
  holdReason: string | null
}) {
  const canWrite = useCanWrite("service")
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  async function run(fn: () => Promise<Response>) {
    setLoading(true)
    setErr(null)
    try {
      const resp = await fn()
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      startTransition(() => router.refresh())
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error")
    } finally {
      setLoading(false)
    }
  }

  function place() {
    // the reason is the whole point of a hold over a flag — it is what the
    // event carries and what the next person reads
    const reason = window.prompt(
      "Why is this on hold? (e.g. 'customer disputing', 'wrong pricing, office to fix')",
      "",
    )
    if (reason === null) return
    void run(() =>
      fetch(`/api/work-orders/${woNumber}/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      }),
    )
  }

  function release() {
    const reason = window.prompt(
      `Release the hold? ${holdReason ? `(held: ${holdReason})` : ""}\nWhat changed?`,
      "",
    )
    if (reason === null) return
    void run(() =>
      fetch(
        `/api/work-orders/${woNumber}/hold?reason=${encodeURIComponent(reason)}`,
        { method: "DELETE" },
      ),
    )
  }

  // UX gate (the route enforces; this hides the button from viewers)
  if (!canWrite) return null
  return (
    <div className="flex items-center gap-2">
      {held ? (
        <Button size="sm" variant="default" onClick={release} disabled={loading}>
          <Play className="w-3.5 h-3.5" strokeWidth={2} />
          {loading ? "Releasing..." : "Release hold"}
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={place} disabled={loading}>
          <Pause className="w-3.5 h-3.5" strokeWidth={2} />
          {loading ? "Holding..." : "Hold"}
        </Button>
      )}
      {err && <span className="text-[11px] text-coral">{err}</span>}
    </div>
  )
}
