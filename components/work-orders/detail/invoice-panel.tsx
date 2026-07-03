import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { InvoiceCard } from "@/components/billing/invoice-card"
import type {
  AppliedPayment,
  InvoiceDetail,
  OpenCredit,
  PaymentMethod,
  WorkOrderDetail,
} from "@/lib/queries/dashboard"
import { paymentChannelLabel } from "@/lib/payment-channel"
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
      {/* Invoice identity + line items — THE shared invoice rendering
          (components/billing/invoice-card); classification injected between
          header fields and line items. */}
      <InvoiceCard
        invoice={invoice}
        afterHeader={
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
                needsReviewReason={invoice.needs_review_reason}
              />
            ) : (
              <LockedClassification invoice={invoice} />
            )}
          </div>
        }
      />

      {/* Applied payments (history) */}
      <AppliedPaymentsCard payments={appliedPayments} />

      {/* Credit review — open unapplied credits with Apply + Override */}
      <CreditReviewCard
        qboInvoiceId={invoice.qbo_invoice_id}
        balance={Number(invoice.balance ?? 0)}
        credits={openCredits}
        overriddenAt={invoice.credit_review_overridden_at}
      />

      {/* Payment methods on file — every active PM in QBO's wallet, with
          the would-charge one highlighted. Read-only on processed
          invoices, EXCEPT when balance > 0 — then each card row gets a
          "Charge $X.XX" button so the user can recover an open balance
          (e.g., emailed invoice that the customer never paid; we still
          have their card on file and want to collect). The
          AppliedPaymentsCard above shows the historical record. */}
      <PaymentMethodsCard
        qboInvoiceId={invoice.qbo_invoice_id}
        methods={paymentMethods}
        preferredPaymentType={invoice.preferred_payment_type}
        disabled={invoice.billing_status === "processed"}
        invoiceBalance={Number(invoice.balance ?? 0)}
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
            invoice.payment_method == null && invoice.preferred_payment_type == null
              ? "—"
              : paymentChannelLabel(invoice)
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
