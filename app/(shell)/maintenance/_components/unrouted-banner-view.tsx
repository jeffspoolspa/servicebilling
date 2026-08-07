"use client"

import { useState } from "react"
import Link from "next/link"
import { AlertTriangle, ChevronDown } from "lucide-react"

const REASON_LABEL: Record<string, string> = {
  needs_review: "needs review",
  out_of_area: "outside service area",
  no_location: "no service address",
}

export interface UnroutedRow {
  customer_id: number
  display_name: string | null
  street: string | null
  city: string | null
  reason: string
}

/** One compact line; the chips live behind the chevron. */
export function UnroutedBannerView({ rows }: { rows: UnroutedRow[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="px-7 pt-3">
      <div className="rounded-lg border border-coral/40 bg-coral/[0.07] px-4 py-2">
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2.5 text-left"
          title="No valid coordinate → no office → not on any route or the territory map. Fix each address to place them."
        >
          <AlertTriangle className="w-4 h-4 shrink-0 text-coral" />
          <span className="text-[12.5px] text-ink min-w-0 truncate">
            {rows.length} customer{rows.length === 1 ? "" : "s"} can’t be routed — service address unresolved
          </span>
          <ChevronDown className={`w-3.5 h-3.5 ml-auto shrink-0 text-ink-mute transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
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
        )}
      </div>
    </div>
  )
}
