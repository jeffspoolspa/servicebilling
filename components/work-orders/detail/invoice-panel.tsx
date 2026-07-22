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
import { CreditReviewCard } from "@/components/work-orders/credit-review-card"
import { AppliedPaymentsCard } from "./applied-payments-card"
import { PaymentMethodsCard } from "./payment-methods-card"
import { PaymentsCreditsTabs } from "./payments-credits-tabs"
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
}: {
  wo: WorkOrderDetail
  invoice: InvoiceDetail | null
  openCredits: OpenCredit[]
  creditDecisions: CreditDecision[]
  billingState: ServiceBillingState | null
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
              <LockedClassification invoice={invoice} state={billingState} />
            )}
          </div>
        }
      />

      {/* Two tabbed views over the same money: payment_invoice_links (what
          IS applied) and the credit decision record (what pre-process saw +
          each credit's outcome). An applied credit appears in both. */}
      <PaymentsCreditsTabs
        appliedCount={appliedPayments.length}
        toDecideCount={
          // derived: open credits without a terminal decision on this invoice
          openCredits.filter(
            (c) =>
              !creditDecisions.some(
                (d) =>
                  d.credit_id === c.qbo_payment_id &&
                  ["applied", "rejected", "stale"].includes(d.state),
              ),
          ).length
        }
        applied={
          appliedPayments.length > 0 ? (
            <AppliedPaymentsCard payments={appliedPayments} />
          ) : (
            <div className="text-[12px] text-ink-mute italic border border-line-soft rounded-lg px-4 py-3">
              No payments applied to this invoice yet.
            </div>
          )
        }
        credits={
          <CreditReviewCard
            qboInvoiceId={invoice.qbo_invoice_id}
            balance={Number(invoice.balance ?? 0)}
            credits={openCredits}
            decisions={creditDecisions}
            overriddenAt={invoice.credit_review_overridden_at}
          />
        }
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
        routeUnresolved={
          billingState && !billingState.pm_resolved
            ? billingState.payment_route
            : null
        }
        methods={paymentMethods}
        preferredPaymentType={invoice.preferred_payment_type}
        disabled={invoice.billing_status === "processed"}
        invoiceBalance={Number(invoice.balance ?? 0)}
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
