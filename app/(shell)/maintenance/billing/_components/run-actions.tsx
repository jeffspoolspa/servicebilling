"use client"

import { useState } from "react"

/**
 * Autopay / send orchestration for one billing month. Both call the existing
 * Windmill engines (f/billing/monthly_autopay, f/billing/send_monthly_invoices)
 * via API routes — nothing is duplicated here. The engines themselves exclude
 * customer-months with an unreviewed HIGH flag; `holdCount` is shown as a
 * reminder of what will be skipped.
 */
export function RunActions({
  month, // 'YYYY-MM'
  monthLabel,
  holdCount,
}: {
  month: string
  monthLabel: string
  holdCount: number
}) {
  const [dryRun, setDryRun] = useState(true)
  const [busy, setBusy] = useState<"autopay" | "send" | null>(null)
  const [result, setResult] = useState<string | null>(null)

  async function run(kind: "autopay" | "send") {
    const label = kind === "autopay" ? "autopay run" : "invoice send"
    if (
      !dryRun &&
      !window.confirm(
        `LIVE ${label} for ${monthLabel}?\n\nThis charges cards / emails customers.` +
          (holdCount > 0
            ? `\n${holdCount} customer-month(s) with unreviewed HIGH flags will be skipped.`
            : ""),
      )
    )
      return
    setBusy(kind)
    setResult(null)
    try {
      const resp = await fetch(`/api/maintenance-billing/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_month: month, dry_run: dryRun }),
      })
      const json = await resp.json()
      if (!resp.ok) throw new Error(json.error ?? `HTTP ${resp.status}`)
      setResult(
        `${dryRun ? "Dry-run" : "Live"} ${label} started (Windmill job ${json.jobId}). ` +
          `Watch it in Windmill; refresh here for status.`,
      )
    } catch (e) {
      setResult(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-[12px] text-ink-mute cursor-pointer">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          Dry run
        </label>
        <button
          onClick={() => run("autopay")}
          disabled={busy !== null}
          className="px-3 py-1.5 text-[12px] font-medium rounded border border-teal/30 text-teal bg-teal/10 hover:bg-teal/20 disabled:opacity-50"
        >
          {busy === "autopay" ? "Starting…" : "Run autopay"}
        </button>
        <button
          onClick={() => run("send")}
          disabled={busy !== null}
          className="px-3 py-1.5 text-[12px] font-medium rounded border border-cyan/30 text-cyan bg-cyan/10 hover:bg-cyan/20 disabled:opacity-50"
        >
          {busy === "send" ? "Starting…" : "Send invoices"}
        </button>
      </div>
      {result && <div className="text-[11px] text-ink-mute max-w-md text-right">{result}</div>}
    </div>
  )
}
