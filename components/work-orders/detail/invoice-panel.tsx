import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { InvoiceCard } from "@/components/billing/invoice-card"
import type {
  AppliedPayment,
  CreditDecision,
  InvoiceDetail,
  OpenCredit,
  PaymentMethod,
  ServiceBillingState,
  WorkOrderDetail,
} from "@/lib/queries/dashboard"
import { paymentChannelLabel } from "@/lib/payment-channel"
import { ClassificationEditor } from "@/components/work-orders/classification-editor"
import { PaymentsCreditsCard } from "./payments-credits-card"
import { FieldFlag } from "@/components/ui/field-flag"

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
  creditDecisions,
  billingState,
  paymentMethods,
  appliedPayments,
  header,
  voided,
}: {
  wo: WorkOrderDetail
  invoice: InvoiceDetail | null
  openCredits: OpenCredit[]
  creditDecisions: CreditDecision[]
  billingState: ServiceBillingState | null
  paymentMethods: PaymentMethod[]
  appliedPayments: AppliedPayment[]
  /** Replaces the card title — the detail page puts its tabs here. */
  header?: React.ReactNode
  /** Derived (billing.v_invoice_state) — suppresses the "paid" pill. */
  voided?: boolean
}) {
  if (!invoice) {
    return (
      <Card>
        <CardHeader className={header ? "pt-2 pb-0" : undefined}>
          {header ?? <CardTitle>Invoice (not yet matched)</CardTitle>}
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
        header={header}
        voided={voided}
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
              <LockedClassification invoice={invoice} state={billingState} />
            )}
          </div>
        }
      />

      {/* ONE table over the money: every recommendation (all open payments/
          credits are recommended) with its outcome — to decide / applied /
          not applicable / lapsed. Replaces the Applied-payments + Credit-
          review tabs. */}
      <PaymentsCreditsCard
        qboInvoiceId={invoice.qbo_invoice_id}
        balance={Number(invoice.balance ?? 0)}
        openCredits={openCredits}
        decisions={creditDecisions}
        appliedPayments={appliedPayments}
      />

    </div>
  )
}

function LockedClassification({
  invoice,
  state,
}: {
  invoice: InvoiceDetail
  state: ServiceBillingState | null
}) {
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
        <Field
          label="QBO class"
          value={invoice.qbo_class ?? "—"}
          flag={
            state && !state.class_present ? (
              <FieldFlag
                show
                title="No QBO class — blocking processing. Re-run pre-processing or set it in Edit classification."
              />
            ) : null
          }
        />
        <Field
          label="Payment method"
          value={
            invoice.payment_method == null && invoice.preferred_payment_type == null
              ? "—"
              : paymentChannelLabel(invoice)
          }
          flag={
            state && !state.pm_resolved ? (
              <FieldFlag
                show
                title={`Route is ${state.payment_route ?? "unresolved"} but no matching method is on file — blocking processing.`}
              />
            ) : null
          }
        />
        <Field
          label="Memo"
          value={invoice.memo ?? "—"}
          flag={
            state && !state.memo_present ? (
              <FieldFlag
                show
                title="No memo — blocking processing. Pre-processing writes it (deterministic or AI); low-confidence memos need a manual edit here."
              />
            ) : null
          }
        />
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  mono = false,
  flag = null,
}: {
  label: string
  value: string
  mono?: boolean
  flag?: React.ReactNode
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute inline-flex items-center gap-1.5">
        {label}
        {flag}
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
