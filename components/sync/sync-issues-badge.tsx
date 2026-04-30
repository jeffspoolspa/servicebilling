"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils/cn"

interface IssueSummary {
  invoice_problems: number
  invoice_stuck_pending: number
  missing_webhooks_24h: number
  unresolved_drift: number
}

/**
 * Global indicator of sync issues across the app. Lives in the sidebar.
 *
 * Refreshes automatically via the realtime invalidator: any UPDATE to
 * billing.invoices, drift_log, or webhook_expectations triggers a refetch
 * of this query (because they're all in the SUBSCRIPTIONS list and we
 * always invalidate the 'sync-issues-summary' key on any tick — see
 * use-realtime-invalidator.ts).
 *
 * Hidden when there are zero issues — Carter shouldn't see this badge
 * during normal operation. Its presence is the alert.
 */
export function SyncIssuesBadge({ collapsed }: { collapsed?: boolean }) {
  const { data } = useQuery<IssueSummary>({
    queryKey: ["sync-issues-summary"],
    queryFn: async () => {
      const r = await fetch("/api/sync/issues/summary")
      if (!r.ok) throw new Error("failed to load issues summary")
      return r.json()
    },
    refetchInterval: 60_000, // backstop in case Realtime drops
  })

  if (!data) return null

  const total =
    data.invoice_problems +
    data.invoice_stuck_pending +
    data.unresolved_drift

  if (total === 0) return null

  const tone = data.invoice_problems > 0 || data.unresolved_drift > 0
    ? "text-coral"
    : "text-sun"

  if (collapsed) {
    return (
      <Link
        href={"/admin/sync-issues" as never}
        title={`${total} sync issue${total === 1 ? "" : "s"}`}
        className="flex items-center justify-center w-8 h-8"
      >
        <span className="relative">
          <AlertTriangle className={cn("w-4 h-4", tone)} strokeWidth={2.5} />
          <span className={cn("absolute -top-1 -right-1 text-[9px] font-mono font-bold", tone)}>
            {total > 9 ? "9+" : total}
          </span>
        </span>
      </Link>
    )
  }

  return (
    <Link
      href={"/admin/sync-issues" as never}
      className="flex items-center gap-2 px-3 py-2 mx-2 rounded-md hover:bg-white/[0.03] transition-colors"
    >
      <AlertTriangle className={cn("w-4 h-4 shrink-0", tone)} strokeWidth={2.5} />
      <span className="flex-1 text-[12px] text-ink">
        Sync issues
      </span>
      <span className={cn("text-[11px] font-mono font-medium", tone)}>{total}</span>
    </Link>
  )
}
