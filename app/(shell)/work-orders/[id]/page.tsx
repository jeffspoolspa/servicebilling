import Link from "next/link"
import { BackButton } from "@/components/shell/back-button"
import { ClipboardList } from "lucide-react"
import { Pill } from "@/components/ui/pill"
import { notFound } from "next/navigation"
import {
  getWorkOrderDetail,
  getInvoiceHistory,
  getInvoiceStreamEvents,
  getCustomerCard,
  getInvoiceState,
  getLatestProcessAttempt,
  getAppliedPaymentsForInvoice,
  type InvoiceState,
} from "@/lib/queries/dashboard"
import { formatDate } from "@/lib/utils/format"
import { HoldButton } from "@/components/work-orders/hold-button"
import { RecoveryBanner } from "@/components/work-orders/recovery-banner"
import { LiveWorkOrderDetail } from "@/components/work-orders/live-work-order-detail"
import {
  DetailTabs,
  type DetailTab,
} from "@/components/work-orders/detail/tabs"
import { WorkOrderPanel } from "@/components/work-orders/detail/work-order-panel"
import { InvoicePanel } from "@/components/work-orders/detail/invoice-panel"
import { SummaryCard } from "@/components/work-orders/detail/summary-card"
import { HistoryPanel } from "@/components/work-orders/detail/history-panel"
import { ProcessingPill } from "@/components/work-orders/detail/processing-pill"
import { CustomerCard } from "@/components/work-orders/detail/customer-card"
import { PaymentMethodInline } from "@/components/work-orders/detail/payment-method-inline"
import { BonusInline } from "@/components/work-orders/detail/bonus-inline"
import { SendInvoiceButton } from "@/components/work-orders/detail/send-invoice-button"
import { createAnon } from "@/lib/supabase/anon"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}

/**
 * The sidebar pill. Reads billing.v_invoice_state — the ONE derivation
 * (ADR-011) — rather than the invoice's stamped billing_status, which kept
 * reporting "processed" after QBO voided the invoice underneath it.
 *
 * `voided` and `on_hold` are flags, not states, so they are returned as extra
 * pills beside the state rather than replacing it.
 */
const STATE_PILL: Record<
  InvoiceState["state"],
  { label: string; tone: "cyan" | "teal" | "sun" | "coral" | "grass" | "neutral" }
> = {
  paid: { label: "paid", tone: "grass" },
  ar: { label: "open A/R", tone: "sun" },
  in_flight: { label: "processing", tone: "cyan" },
  needs_review: { label: "needs review", tone: "coral" },
  audit: { label: "audit", tone: "coral" },
}

function summaryPills(
  billable: boolean,
  skipped: boolean,
  state: InvoiceState | null,
): { label: string; tone: "cyan" | "teal" | "sun" | "coral" | "grass" | "neutral" }[] {
  if (skipped) return [{ label: "skipped", tone: "neutral" }]
  if (!billable) return [{ label: "not billable", tone: "neutral" }]
  // no invoice yet is a real state of the WO, not of an invoice
  if (!state) return [{ label: "awaiting invoice", tone: "cyan" }]
  return [
    STATE_PILL[state.state],
    ...(state.voided ? [{ label: "voided", tone: "coral" as const }] : []),
    ...(state.on_hold ? [{ label: "on hold", tone: "sun" as const }] : []),
  ]
}

export default async function WorkOrderDetailPage({ params, searchParams }: PageProps) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const data = await getWorkOrderDetail(id)
  if (!data) notFound()

  const { wo, invoice, openCredits, creditDecisions, billingState, paymentMethods } = data
  const skipped = wo.skipped_at != null
  const techDisplay = wo.assigned_to?.split(",")[1]?.trim() ?? wo.assigned_to ?? "—"

  // Default tab: invoice when one is linked, else work. URL param overrides.
  const requestedTab = sp.tab === "work" || sp.tab === "invoice" ? sp.tab : null
  const activeTab: DetailTab =
    requestedTab ?? (invoice ? "invoice" : "work")

  // Parallel fetch what the panels need.
  // - processAttempt: latest only (still used by RecoveryBanner)
  // - appliedPayments: for the applied-payments card
  // - historyEvents: sidebar History feed
  const customerId = invoice?.qbo_customer_id ?? null
  const sb = createAnon("public")
  const [
    processAttempt,
    appliedPayments,
    historyEvents,
    streamEvents,
    custPrefRow,
    customerCard,
    openHold,
    invoiceState,
  ] =
    await Promise.all([
      invoice?.qbo_invoice_id
        ? getLatestProcessAttempt(invoice.qbo_invoice_id)
        : Promise.resolve(null),
      invoice?.qbo_invoice_id
        ? getAppliedPaymentsForInvoice(invoice.qbo_invoice_id)
        : Promise.resolve([]),
      invoice?.qbo_invoice_id
        ? getInvoiceHistory(invoice.qbo_invoice_id)
        : Promise.resolve([]),
      invoice?.qbo_invoice_id
        ? getInvoiceStreamEvents(invoice.qbo_invoice_id)
        : Promise.resolve([]),
      // Local Customers.id for the /customers/[id] link.
      customerId
        ? sb
            .from("Customers")
            .select("id")
            .eq("qbo_customer_id", customerId)
            .maybeSingle()
            .then((r) => r.data as { id: number | string } | null)
        : Promise.resolve(null),
      // Header context: billing route, credits, open A/R.
      getCustomerCard(customerId),
      // The open hold, if any. Subject is the WO — the gate
      // (billing.invoice_on_hold) honours a hold on either side.
      createAnon("billing")
        .from("holds")
        .select("reason, placed_by, placed_at")
        .eq("subject_type", "work_order")
        .eq("subject_id", id)
        .is("released_at", null)
        .maybeSingle()
        .then((r) => r.data as { reason: string; placed_by: string; placed_at: string } | null),
      // ADR-011 derived state — what the sidebar pill reports.
      invoice?.qbo_invoice_id
        ? getInvoiceState(invoice.qbo_invoice_id)
        : Promise.resolve(null),
    ])

  const pills = summaryPills(wo.billable, skipped, invoiceState)

  // Invoice tab should show an attention dot if there's something to look at
  const invoiceAttention =
    invoice?.billing_status === "needs_review" ||
    Boolean(invoice?.needs_review_reason)

  // Local Customers.id (for the /customers/[id] link). Resolved from the
  // invoice's qbo_customer_id; null when there's no invoice yet (no link).
  const customerLocalId = custPrefRow?.id ?? null

  return (
    <>
      {/* Subscribes to billing.invoices, billing.processing_attempts,
          billing.customer_payments, public.work_orders. Triggers
          router.refresh() (debounced 350ms) when any change. Without this
          the detail page is stale until manual reload. */}
      <LiveWorkOrderDetail />
      {/* The header is the CUSTOMER, not the work order — the WO's own details
          fill the page below. Name (linked to their page) and what they owe;
          everything else about them lives one click away. The Sync /
          Pre-process / Process / Mark-processed controls that lived here are
          gone — each fired a step that now happens on its own, and a manual
          second path to money has none of the queue's guards. */}
      <div className="px-7 pt-6">
      <div className="flex items-center gap-3 mb-3">
        <BackButton />
        <span className="text-[12px] text-ink-mute">
          {wo.type} · {wo.office_name ?? "—"} · WO {wo.wo_number} · {techDisplay} ·
          completed {formatDate(wo.completed)}
        </span>
        {invoice && <ProcessingPill stream={streamEvents} />}
        <span className="ml-auto">
          {/* A hold is a BILLING decision (don't transact on this yet), not a
              processing control — it survived the header cleanup. Unlike the
              Skip flag it replaced, it lives in billing.holds and emits an
              event both ways, so the reason is in the invoice's history. */}
          <HoldButton
            woNumber={wo.wo_number}
            held={Boolean(openHold)}
            holdReason={openHold?.reason ?? null}
          />
        </span>
      </div>
      {customerCard && (
        <CustomerCard data={customerCard} />
      )}
      </div>

      {openHold && (
        <div className="px-7 pt-5">
          <div className="rounded-lg border border-sun/30 bg-sun/[0.06] px-4 py-3 flex items-center gap-3">
            <div className="text-ink-dim text-[12px]">
              <span className="text-sun font-medium">On hold</span>
              <span className="ml-2">— {openHold.reason}</span>
              <span className="text-ink-mute ml-2">
                {openHold.placed_by} · {new Date(openHold.placed_at).toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Recovery banner rendered above tabs — high-priority state for charges */}
      {processAttempt && invoice && (
        <div className="px-7 pt-5">
          <RecoveryBanner
            attempt={processAttempt}
            qboInvoiceId={invoice.qbo_invoice_id}
          />
        </div>
      )}

      <div className="px-7 py-6 grid grid-cols-3 gap-5">
        {/* Left 2/3 — tab content */}
        <div className="col-span-2 flex flex-col gap-5">
          {(() => {
            // one node, handed to whichever panel is showing — the tabs are
            // that card's header, not a nav bar sitting above it
            const tabs = (
              <DetailTabs
                active={activeTab}
                woNumber={wo.wo_number}
                invoiceAttention={invoiceAttention}
                invoiceDisabled={!invoice}
                docNumber={invoice?.doc_number ?? null}
              />
            )
            return activeTab === "work" ? (
              <WorkOrderPanel wo={wo} header={tabs} />
            ) : (
              <InvoicePanel
                wo={wo}
                invoice={invoice}
                openCredits={openCredits}
                creditDecisions={creditDecisions}
                billingState={billingState}
                paymentMethods={paymentMethods}
                appliedPayments={appliedPayments}
                header={tabs}
                voided={invoiceState?.voided ?? false}
              />
            )
          })()}
        </div>

        {/* Right 1/3 — persistent sidebar (summary + pre-processing + processing) */}
        <div className="flex flex-col gap-5">
          <SummaryCard
            wo={wo}
            invoice={invoice}
            pills={pills}
            state={billingState}
            send={
              invoice && !invoiceState?.voided && !openHold ? (
                <SendInvoiceButton
                  qboInvoiceId={invoice.qbo_invoice_id}
                  hasOpenBalance={Number(invoice.balance ?? 0) > 0}
                />
              ) : undefined
            }
            bonus={
              invoice ? (
                <BonusInline
                  woNumber={wo.wo_number}
                  initialOverride={wo.included_in_bonus}
                  qboClass={invoice.qbo_class}
                />
              ) : undefined
            }
          />
          {invoice && (
            <PaymentMethodInline
              qboInvoiceId={invoice.qbo_invoice_id}
              methods={paymentMethods}
              preferredPaymentType={
                invoice.preferred_payment_type as
                  | "email" | "ach" | "credit_card" | "card" | null
              }
              routeUnresolved={
                billingState && !billingState.pm_resolved
                  ? billingState.payment_route
                  : null
              }
              disabled={invoice.billing_status === "processed"}
              invoiceBalance={Number(invoice.balance ?? 0)}
            />
          )}
          {invoice && <HistoryPanel events={historyEvents} stream={streamEvents} />}
        </div>
      </div>
    </>
  )
}
