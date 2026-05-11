"use client"

import { useSearchParams } from "next/navigation"
import { useState } from "react"
import { Download, Loader2 } from "lucide-react"
import { useCanWrite } from "@/components/providers/access-provider"

/**
 * "Download CSV" button for the WO table. Mirrors the current page's
 * filter+sort by reading them from useSearchParams and forwarding them
 * to /api/work-orders/export. Streams the response into a blob and
 * triggers a browser download — that way we can show errors (e.g. 413
 * "exceeds 50k cap") inline rather than the user staring at a blank
 * download dialog.
 *
 * Visible to anyone with read access to the service module — nothing
 * here mutates state.
 */
export function DownloadCsvButton() {
  // Even read-only viewers should get this — it's just a download of
  // what they already see. We treat it as "available if you can see
  // the page" rather than gating to write access.
  const _hasAccess = useCanWrite("service") || true
  void _hasAccess
  const searchParams = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onClick() {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      const qs = searchParams.toString()
      const url = qs ? `/api/work-orders/export?${qs}` : `/api/work-orders/export`
      const resp = await fetch(url)
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body?.error ?? `${resp.status} ${resp.statusText}`)
      }
      // Pull filename from Content-Disposition so the saved file matches
      // the server-built name (which encodes the active filter).
      const cd = resp.headers.get("content-disposition") ?? ""
      const match = cd.match(/filename="?([^"]+)"?/)
      const filename = match?.[1] ?? "work-orders.csv"

      const blob = await resp.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = blobUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(blobUrl)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "download failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title="Download the currently-filtered work orders as CSV"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-ink-dim border border-line-soft hover:text-ink hover:border-line transition-colors disabled:opacity-60 disabled:cursor-wait"
      >
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
        ) : (
          <Download className="w-3.5 h-3.5" strokeWidth={1.8} />
        )}
        {busy ? "Building…" : "Download CSV"}
      </button>
      {err && (
        <span className="text-[11px] text-coral max-w-[260px] truncate" title={err}>
          {err}
        </span>
      )}
    </div>
  )
}
