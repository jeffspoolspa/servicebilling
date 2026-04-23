import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import type {
  AppliedPayment,
  InvoiceDetail,
  LineItem,
  OpenCredit,
  PaymentMethod,
  WorkOrderDetail,
} from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"
import { ClassificationEditor } from "@/components/work-orders/classification-editor"
import { CreditReviewCard } from "@/components/work-orders/credit-review-card"
import { AppliedPaymentsCard } from "./applied-payments-card"
import { PaymentMethodsCard } from "./payment-methods-card"

/**
 * Invoice tab — everything about the QBO invoice side:
 *   - Invoice identity + line items
 *   - Classification (editable when needs_review/awaiting, read-only otherwise)
 *   - Applied payments (history, from payment_invoice_links)
 *   - Credit review (unapplied open credits + apply/override actions)
 *   - Payment methods on file
 *
 * The whole tab is basically a stack of cards, each addressing one concern.
 * Classification is shown editable OR as a locked readout so the user never
 * needs to scroll to a separate editor container.
 */
export function InvoicePanel({
  wo,
  invoice,
  openCredits,
  paymentMethods,
  appliedPayments,
}: {
  wo: WorkOrderDetail
  invoice: InvoiceDetail | null
  openCredits: OpenCredit[]
  paymentMethods: PaymentMethod[]
  appliedPayments: AppliedPayment[]
}) {
  if (!invoice) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invoice (not yet matched)</CardTitle>
        </CardHeader>
        <CardBody className="text-ink-mute text-sm">
          {wo.invoice_number
            ? `Invoice ${wo.invoice_number} hasn't been pulled from QBO yet. Wait for the next pull_qbo_invoices cycle.`
            : "This WO doesn't have an invoice number yet — office hasn't entered it in ION."}
        </CardBody>
      </Card>
    )
  }

  const isEditable =
    invoice.billing_status === "needs_review" ||
    invoice.billing_status === "awaiting_pre_processing"

  return (
    <div className="flex flex-col gap-5">
      {/* Invoice identity + line items */}
      <Card>
        <CardHeader>
          <CardTitle>Invoice {invoice.doc_number}</CardTitle>
          <div className="ml-auto flex items-center gap-2">
            {invoice.email_status === "EmailSent" ? (
              <Pill tone="teal" dot>
                sent
              </Pill>
            ) : (
              <Pill tone="neutral" dot>
                not sent
              </Pill>
            )}
            {Number(invoice.balance) === 0 ? (
              <Pill tone="grass" dot>
                paid
              </Pill>
            ) : (
              <Pill tone="sun" dot>
                balance {formatCurrency(Number(invoice.balance))}
              </Pill>
            )}
          </div>
        </CardHeader>
        <div className="px-5 py-3 grid grid-cols-5 gap-4 text-[12px] border-b border-line-soft">
          <Field label="Customer" value={invoice.customer_name ?? "—"} />
          <Field label="Txn date" value={formatDate(invoice.txn_date)} />
          <Field
            label="Subtotal"
            value={formatCurrency(Number(invoice.subtotal ?? 0))}
            mono
          />
          {/* Tax derived from (total − subtotal). QBO's TxnTaxDetail.TotalTax
              is also in raw but this arithmetic is always in sync with what
              the customer sees on the invoice. */}
          <Field
            label="Tax"
            value={formatCurrency(
              Math.max(
                0,
                Number(
                  (
                    Number(invoice.total_amt ?? 0) - Number(invoice.subtotal ?? 0)
                  ).toFixed(2),
                ),
              ),
            )}
            mono
          />
          <Field
            label="Total"
            value={formatCurrency(Number(invoice.total_amt ?? 0))}
            mono
          />
        </div>

        {/* Classification — editable inline when state allows; locked display otherwise.
            Replaces the old standalone ClassificationEditor card. */}
        <div className="border-b border-line-soft">
          {isEditable ? (
            <ClassificationEditor
              qboInvoiceId={invoice.qbo_invoice_id}
              initial={{
                qbo_class: invoice.qbo_class,
                payment_method: invoice.payment_method,
                memo: invoice.memo,
                statement_memo: invoice.statement_memo,
              }}
              canMarkReady={invoice.billing_status === "needs_review"}
            />
          ) : (
            <LockedClassification invoice={invoice} />
          )}
        </div>

        {/* Line items */}
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-ink-mute border-b border-line-soft bg-[#0c1926]">
                <th className="px-5 py-2 font-medium">Item</th>
                <th className="font-medium">Description</th>
                <th className="font-medium num text-right">Qty</th>
                <th className="font-medium num text-right">Unit</th>
                <th className="font-medium num text-right pr-5">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(invoice.line_items ?? []).map((li: LineItem, idx: number) => {
                const isSubtotal = li.line_type === "subtotal"
                const isDiscount = li.line_type === "discount"
                return (
                  <tr
                    key={idx}
                    className={
                      "border-b border-line-soft " +
                      (isSubtotal ? "bg-white/[0.02] font-medium" : "")
                    }
                  >
                    <td className="px-5 py-2">
                      {isSubtotal ? (
                        <span className="text-ink-dim text-[11px] uppercase tracking-wider">
                          Subtotal
                        </span>
                      ) : isDiscount ? (
                        <span className="text-coral text-xs">Discount</span>
                      ) : (
                        <span className="text-ink text-xs">{li.item_name ?? "—"}</span>
                      )}
                    </td>
                    <td className="text-ink-dim text-xs">{li.description || "—"}</td>
                    <td className="num text-right text-ink-mute text-xs">
                      {li.qty != null ? li.qty : ""}
                    </td>
                    <td className="num text-right text-ink-mute text-xs">
                      {li.unit_price != null ? formatCurrency(li.unit_price) : ""}
                    </td>
                    <td
                      className={
                        "num text-right pr-5 " +
                        (isSubtotal ? "text-ink" : "text-ink-dim") +
                        (isDiscount ? " text-coral" : "")
                      }
                    >
                      {formatCurrency(Number(li.amount ?? 0))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {(invoice.line_items?.length ?? 0) === 0 && (
            <div className="px-5 py-6 text-center text-ink-mute text-sm">
              No line items returned from QBO.
            </div>
          )}
        </div>
      </Card>

      {/* Applied payments (history) */}
      <AppliedPaymentsCard payments={appliedPayments} />

      {/* Credit review — open unapplied credits with Apply + Override */}
      <CreditReviewCard
        qboInvoiceId={invoice.qbo_invoice_id}
        balance={Number(invoice.balance ?? 0)}
        credits={openCredits}
        overriddenAt={invoice.credit_review_overridden_at}
      />

      {/* Payment method on file — only defaults surfaced; click to override */}
      <PaymentMethodsCard
        qboInvoiceId={invoice.qbo_invoice_id}
        methods={paymentMethods}
        preferredPaymentType={invoice.preferred_payment_type}
      />
    </div>
  )
}

function LockedClassification({ invoice }: { invoice: InvoiceDetail }) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[10px] uppercase tracking-[0.1em] text-ink-mute">
          Classification
        </div>
        <span className="text-[10px] text-ink-mute">
          locked — revert to edit
        </span>
      </div>
      <div className="grid grid-cols-3 gap-4 text-[12px]">
        <Field label="QBO class" value={invoice.qbo_class ?? "—"} />
        <Field
          label="Payment method"
          value={
            invoice.payment_method === "on_file"
              ? "On file"
              : invoice.payment_method === "invoice"
                ? "Invoice (email)"
                : "—"
          }
        />
        <Field label="Memo" value={invoice.memo ?? "—"} />
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
        {label}
      </div>
      <div
        className={`${mono ? "num text-ink" : "text-ink"} mt-0.5 truncate`}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}
