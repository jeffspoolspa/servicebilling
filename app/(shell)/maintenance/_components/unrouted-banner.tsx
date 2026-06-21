import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { listUnroutedCustomers } from "../_lib/views"

/**
 * Prominent warning shown across every /maintenance/* page (rendered in the layout):
 * customers with ACTIVE tasks whose service address is unresolved can't be geocoded →
 * can't get a geographic office → can't be placed on a route. Each chip links to the
 * customer page, where the in-app address editor resolves it (ADR 007). Renders nothing
 * when everything is routable.
 */
const REASON_LABEL: Record<string, string> = {
  needs_review: "needs review",
  out_of_area: "outside service area",
  no_location: "no service address",
}

export async function UnroutedBanner() {
  const rows = await listUnroutedCustomers()
  if (rows.length === 0) return null

  return (
    <div className="px-7 pt-3">
      <div className="rounded-lg border border-coral/40 bg-coral/[0.07] px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-coral" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink">
              {rows.length} customer{rows.length === 1 ? "" : "s"} with active maintenance can’t be routed — service address unresolved
            </div>
            <div className="text-[11px] text-ink-mute mt-0.5">
              No valid coordinate → no office → not on any route or the territory map. Fix each address to place them.
            </div>
            <ul className="mt-2.5 flex flex-wrap gap-1.5">
              {rows.map((r) => (
                <li key={r.customer_id}>
                  <Link
                    href={`/maintenance/customers/${r.customer_id}` as never}
                    className="inline-flex items-center gap-1.5 rounded-full border border-coral/30 bg-white/[0.03] px-2.5 py-1 text-[11px] text-ink hover:bg-white/[0.07] hover:border-coral/50 transition-colors"
                  >
                    <span className="font-medium">{r.display_name ?? `#${r.customer_id}`}</span>
                    <span className="text-ink-mute">
                      {[r.street, r.city].filter(Boolean).join(", ") || REASON_LABEL[r.reason] || r.reason}
                    </span>
                    <span className="text-coral/80">Fix →</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
