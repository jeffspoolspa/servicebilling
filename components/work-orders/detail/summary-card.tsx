import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import type { InvoiceDetail, WorkOrderDetail } from "@/lib/queries/dashboard"

/**
 * Sidebar summary — persists across Work Order and Invoice tabs.
 * Shows the money facts + overall status at a glance, so the user always
 * knows what's on the line regardless of which tab they're looking at.
 *
 * Adapts to state: when invoice is linked, invoice-side numbers are
 * authoritative (includes tax, balance, etc). When only WO exists, we
 * fall back to WO facts.
 */

interface Status {
  label: string
  tone: "cyan" | "teal" | "sun" | "coral" | "grass" | "neutral"
}

interface Props {
  wo: WorkOrderDetail
  invoice: InvoiceDetail | null
  status: Status
}

export function SummaryCard({ wo, invoice, status }: Props) {
  const hasInvoice = invoice != null
  const subtotal = hasInvoice ? Number(invoice!.subtotal ?? 0) : Number(wo.sub_total ?? 0)
  const total = hasInvoice ? Number(invoice!.total_amt ?? 0) : Number(wo.total_due ?? 0)
  // Derive tax: invoice-side is authoritative (total - subtotal). Fall back to
  // WO-side when we have no invoice. WO tax_total is often null for taxable
  // items because ION reports pre-tax, so we can't trust it for the summary.
  const taxTotal = hasInvoice
    ? Math.max(0, Number((total - subtotal).toFixed(2)))
    : Number(wo.tax_total ?? 0)
  const balance = hasInvoice ? Number(invoice!.balance ?? 0) : Number(wo.total_due ?? 0)
  const paid = hasInvoice && balance === 0
  const sent = invoice?.email_status === "EmailSent"

  return (
    <Card>
      <CardHeader>
        <CardTitle>Summary</CardTitle>
        <div className="ml-auto flex items-center gap-1.5">
          <Pill tone={status.tone} dot>
            {status.label}
          </Pill>
        </div>
      </CardHeader>
      <CardBody className="text-sm space-y-2">
        <Row label="Subtotal">
          <span className="num text-ink-dim">{formatCurrency(subtotal)}</span>
        </Row>
        <Row label="Tax">
          <span className="num text-ink-dim">{formatCurrency(taxTotal)}</span>
        </Row>
        <div className="h-px bg-line-soft my-1" />
        <Row label="Total">
          <span className="num text-ink font-medium">{formatCurrency(total)}</span>
        </Row>
        {hasInvoice && (
          <>
            <Row label="Balance">
              {paid ? (
                <span className="text-grass font-medium">Paid</span>
              ) : (
                <span className="num text-sun font-medium">{formatCurrency(balance)}</span>
              )}
            </Row>
            <div className="pt-2 border-t border-line-soft text-[11px] flex items-center gap-2 flex-wrap">
              <span className="text-ink-mute">Invoice</span>
              <span className="font-mono text-ink-dim">{invoice!.doc_number}</span>
              <span className="text-ink-mute">·</span>
              {sent ? (
                <span className="text-teal">sent</span>
              ) : (
                <span className="text-ink-mute">not sent</span>
              )}
              {invoice!.payment_method && (
                <>
                  <span className="text-ink-mute">·</span>
                  <span
                    className={
                      invoice!.payment_method === "on_file"
                        ? "text-cyan"
                        : "text-ink-dim"
                    }
                  >
                    {invoice!.payment_method === "on_file" ? "on file" : "invoice"}
                  </span>
                </>
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-ink-mute">{label}</span>
      {children}
    </div>
  )
}
