import Link from "next/link"
import { Card, CardBody } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"

/**
 * Who this work order belongs to, and what they owe. One line, above the
 * work-order / invoice tabs.
 *
 * It replaced the WO title block and its row of controls. Those controls
 * (Sync, Pre-process, Process, Mark processed) each fired a step that now
 * happens on its own, and a manual second path to money has none of the
 * queue's guards. The status pill went with them: what an invoice IS reads
 * off sent + paid, which the invoice panel below already shows.
 *
 * Everything else about the customer lives on their detail page — this is a
 * pointer to it, not a copy of it.
 */

export interface CustomerCardData {
  qboCustomerId: string | null
  localId: string | null
  name: string
  accountType: string | null
  accountName: string | null
  isActive: boolean | null
  email: string | null
  phone: string | null
  address: string | null
  preferredPaymentType: string | null
  resolvedRoute: string | null
  defaultMethod: { type: string; brand: string | null; lastFour: string | null } | null
  activeMethodCount: number
  openArTotal: number
  openArCount: number
  openCreditTotal: number
  openCreditCount: number
  invoices: {
    qbo_invoice_id: string
    doc_number: string | null
    txn_date: string | null
    total_amt: number | null
    balance: number | null
    sent: boolean
    paid: boolean
    wo_number: string | null
  }[]
}

export function CustomerCard({ data }: { data: CustomerCardData }) {
  const owed = data.openArTotal > 0

  // Name AND balance are the link — both are questions you answer on the
  // customer's page (what else do they owe, what's on file, what did we send),
  // so the whole row is the target rather than four characters of name.
  const body = (
    <>
      <span className="text-[14px] font-medium text-ink truncate">{data.name}</span>
      <span className="flex items-baseline gap-2 shrink-0">
        <span className="text-[10px] uppercase tracking-[0.1em] text-ink-mute">
          Open balance
        </span>
        <span
          className={
            "text-[16px] font-medium tabular-nums " +
            (owed ? "text-coral" : "text-ink-mute")
          }
        >
          {formatCurrency(data.openArTotal)}
        </span>
      </span>
    </>
  )

  return (
    <Card>
      {data.localId ? (
        <Link
          href={`/customers/${data.localId}/billing` as never}
          className="flex items-baseline justify-between gap-4 px-5 py-3 hover:bg-line-soft/40 transition-colors"
        >
          {body}
        </Link>
      ) : (
        // no local Customers row to link to — the WO has no invoice yet, so
        // there is no qbo_customer_id to resolve from
        <CardBody className="flex items-baseline justify-between gap-4 py-3">
          {body}
        </CardBody>
      )}
    </Card>
  )
}
