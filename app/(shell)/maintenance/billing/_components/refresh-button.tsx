"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

/**
 * Refresh the month's bills: rebuilds the invoice promises from visits
 * (f/billing_audit/build_task_billing_periods, synchronous) and kicks the ION
 * transactions-report pull (f/ION/transactions_report, async browser scrape —
 * invoice numbers/amounts land when it finishes). Safe to run any time
 * mid-month; locked months are never touched.
 */
export function RefreshButton({ month }: { month: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  async function refresh() {
    setBusy(true)
    setResult(null)
    try {
      const resp = await fetch("/api/maintenance-billing/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_month: month }),
      })
      const json = await resp.json()
      if (!resp.ok) throw new Error(json.error ?? `HTTP ${resp.status}`)
      setResult(
        `Rebuilt ${json.promises ?? "?"} promises. ION report pull started ` +
          `(job ${json.report_job_id}) — invoice numbers stamp and statuses move ` +
          `to "ion matched" when it lands (a few minutes).`,
      )
      startTransition(() => router.refresh())
    } catch (e) {
      setResult(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={refresh}
        disabled={busy}
        className="px-3 py-1.5 text-[12px] font-medium rounded border border-line text-ink-dim bg-white/[0.03] hover:bg-white/[0.06] disabled:opacity-50"
      >
        {busy ? "Refreshing…" : "Refresh bills"}
      </button>
      {result && <div className="text-[11px] text-ink-mute max-w-sm text-right">{result}</div>}
    </div>
  )
}
