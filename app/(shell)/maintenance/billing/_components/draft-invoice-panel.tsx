"use client"

import { useEffect, useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCurrency } from "@/lib/utils/format"
import { cn } from "@/lib/utils/cn"

/**
 * The month's DRAFT invoice — fetched from the aggregate projection, never
 * stored, so it is always the current truth of the ledger. What the
 * reviewer sees here is what the issue step will build.
 */

interface DraftLine {
  kind: string
  itemName: string
  qty: number
  unitPriceCents: number
  amountCents: number
  detail: string | null
}
interface Draft {
  lines: DraftLine[]
  subtotalCents: number
  claimedAtZero: number
}

export function DraftInvoicePanel({ monthId }: { monthId: string }) {
  const [draft, setDraft] = useState<Draft | "loading" | "error">("loading")
  useEffect(() => {
    let alive = true
    setDraft("loading")
    fetch(`/api/billing/months/${monthId}/draft-invoice`)
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error)))))
      .then((j) => alive && setDraft(j as Draft))
      .catch(() => alive && setDraft("error"))
    return () => {
      alive = false
    }
  }, [monthId])

  if (draft === "loading") return <div className="text-[11px] text-ink-mute">Building draft…</div>
  if (draft === "error") return <div className="text-[11px] text-coral">Failed to build the draft invoice.</div>
  return (
    <div className="rounded-lg border border-line-soft overflow-hidden">
      <Table className="text-[11px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent bg-white/[0.02]">
            <TableHead>Item</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Unit</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {draft.lines.map((l, i) => (
            <TableRow key={i} className={cn("text-ink-dim", l.kind === "variance" && "text-sun")}>
              <TableCell>
                {l.itemName}
                {l.detail && <span className="ml-2 text-ink-mute">— {l.detail}</span>}
              </TableCell>
              <TableCell className="text-right font-mono num">{l.qty}</TableCell>
              <TableCell className="text-right font-mono num">{formatCurrency(l.unitPriceCents / 100)}</TableCell>
              <TableCell className="text-right font-mono num text-ink">{formatCurrency(l.amountCents / 100)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow className="text-ink hover:bg-transparent">
            <TableCell>
              Subtotal
              {draft.claimedAtZero > 0 && (
                <span className="ml-2 text-[10px] text-ink-mute">({draft.claimedAtZero} visit(s) claimed at $0)</span>
              )}
            </TableCell>
            <TableCell />
            <TableCell />
            <TableCell className="text-right font-mono num font-semibold">{formatCurrency(draft.subtotalCents / 100)}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
      <p className="px-3 py-1.5 text-[10px] text-ink-mute border-t border-line-soft">
        Draft — regenerated from the ledger on every view; edits to visits reprice it on the next accrue.
      </p>
    </div>
  )
}
