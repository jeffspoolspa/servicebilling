import { ObjectHeader } from "@/components/shell/object-header"
import { ClipboardList } from "lucide-react"
import { Pill } from "@/components/ui/pill"
import { notFound } from "next/navigation"
import {
  getWorkOrderDetail,
  getLatestProcessAttempt,
  getAppliedPaymentsForInvoice,
} from "@/lib/queries/dashboard"
import { formatDate } from "@/lib/utils/format"
import { PreProcessButton } from "@/components/work-orders/pre-process-button"
import { ProcessButton } from "@/components/work-orders/process-button"
import { RevertButton } from "@/components/work-orders/revert-button"
import { SyncButton } from "@/components/work-orders/sync-button"
import { SkipButton } from "@/components/work-orders/skip-button"
import { RecoveryBanner } from "@/components/work-orders/recovery-banner"
import { ProcessingCard } from "@/components/work-orders/processing-card"
import {
  DetailTabs,
  type DetailTab,
} from "@/components/work-orders/detail/tabs"
import { WorkOrderPanel } from "@/components/work-orders/detail/work-order-panel"
import { InvoicePanel } from "@/components/work-orders/detail/invoice-panel"
import { SummaryCard } from "@/components/work-orders/detail/summary-card"
import { PreProcessingCard } from "@/components/work-orders/detail/pre-processing-card"
import { BonusCard } from "@/components/work-orders/detail/bonus-card"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}

/**
 * Derived UI status for the ribbon + summary pill.
 * WOs no longer carry billing_status — it lives on the linked invoice.
 */
function deriveStatus(
  billable: boolean,
  qboInvoiceId: string | null,
  invoiceStatus: string | null,
  skipped: boolean,
): { label: string; tone: "cyan" | "teal" | "sun" | "coral" | "grass" | "neutral" } {
  if (skipped) return { label: "skipped", tone: "neutral" }
  if (!billable) return { label: "not billable", tone: "neutral" }
  if (!qboInvoiceId) return { label: "awaiting invoice", tone: "cyan" }
  switch (invoiceStatus) {
    case "awaiting_pre_processing":
      return { label: "awaiting pre-processing", tone: "cyan" }
    case "needs_review":
      return { label: "needs review", tone: "coral" }
    case "ready_to_process":
      return { label: "ready to process", tone: "teal" }
    case "processing":
      return { label: "processing", tone: "sun" }
    case "processed":
      return { label: "processed", tone: "grass" }
    default:
      return { label: "matched", tone: "cyan" }
  }
}

export default async function WorkOrderDetailPage({ params, searchParams }: PageProps) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const data = await getWorkOrderDetail(id)
  if (!data) notFound()

  const { wo, invoice, openCredits, paymentMethods } = data
  const skipped = wo.skipped_at != null
  const status = deriveStatus(
    wo.billable,
    wo.qbo_invoice_id,
    invoice?.billing_status ?? null,
    skipped,
  )
  const techDisplay = wo.assigned_to?.split(",")[1]?.trim() ?? wo.assigned_to ?? "—"

  // Default tab: invoice when one is linked, else work. URL param overrides.
  const requestedTab = sp.tab === "work" || sp.tab === "invoice" ? sp.tab : null
  const activeTab: DetailTab =
    requestedTab ?? (invoice ? "invoice" : "work")

  // Parallel fetch what the panels need
  const [processAttempt, appliedPayments] = await Promise.all([
    invoice?.qbo_invoice_id
      ? getLatestProcessAttempt(invoice.qbo_invoice_id)
      : Promise.resolve(null),
    invoice?.qbo_invoice_id
      ? getAppliedPaymentsForInvoice(invoice.qbo_invoice_id)
      : Promise.resolve([]),
  ])

  // Invoice tab should show an attention dot if there's something to look at
  const invoiceAttention =
    invoice?.billing_status === "needs_review" ||
    Boolean(invoice?.needs_review_reason)

  return (
    <>
      <ObjectHeader
        eyebrow={`${wo.type} · ${wo.office_name ?? "—"}`}
        title={`WO ${wo.wo_number}`}
        sub={`${wo.customer ?? "—"} · ${techDisplay} · completed ${formatDate(wo.completed)}`}
        icon={<ClipboardList className="w-6 h-6" strokeWidth={1.8} />}
        actions={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <Pill tone={status.tone} dot>
              {status.label}
            </Pill>
            {wo.invoice_number && !skipped && <SyncButton woNumber={wo.wo_number} />}

            {/* State-aware processing controls */}
            {invoice && !skipped && (
              <>
                {(invoice.billing_status === "awaiting_pre_processing" ||
                  invoice.billing_status === "needs_review") && (
                  <PreProcessButton qboInvoiceId={invoice.qbo_invoice_id} />
                )}
                {invoice.billing_status === "ready_to_process" && (
                  <>
                    <RevertButton qboInvoiceId={invoice.qbo_invoice_id} />
                    <ProcessButton
                      qboInvoiceId={invoice.qbo_invoice_id}
                      balance={Number(invoice.balance ?? 0)}
                      paymentMethod={invoice.payment_method}
                    />
                  </>
                )}
              </>
            )}
            {/* Skip is only a pre-processing option — once the invoice is
                ready_to_process or later, skipping would abandon work we've
                already done. Always show Unskip so a prior skip can be
                reversed even if the invoice has since moved forward. */}
            {(() => {
              const canSkip = !invoice ||
                invoice.billing_status === "awaiting_pre_processing"
              if (skipped || canSkip) {
                return (
                  <SkipButton
                    woNumber={wo.wo_number}
                    skipped={skipped}
                    skippedReason={wo.skipped_reason}
                  />
                )
              }
              return null
            })()}
          </div>
        }
      />

      {skipped && (
        <div className="px-7 pt-5">
          <div className="rounded-lg border border-line-soft bg-white/[0.02] px-4 py-3 flex items-center gap-3">
            <div className="text-ink-dim text-[12px]">
              <span className="text-ink font-medium">Skipped</span>
              {wo.skipped_at && (
                <span className="text-ink-mute ml-2">
                  {new Date(wo.skipped_at).toLocaleString()}
                </span>
              )}
              {wo.skipped_reason && <span className="ml-2">— {wo.skipped_reason}</span>}
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
          <DetailTabs
            active={activeTab}
            woNumber={wo.wo_number}
            invoiceAttention={invoiceAttention}
            invoiceDisabled={!invoice}
          />
          {activeTab === "work" ? (
            <WorkOrderPanel wo={wo} />
          ) : (
            <InvoicePanel
              wo={wo}
              invoice={invoice}
              openCredits={openCredits}
              paymentMethods={paymentMethods}
              appliedPayments={appliedPayments}
            />
          )}
        </div>

        {/* Right 1/3 — persistent sidebar (summary + pre-processing + processing) */}
        <div className="flex flex-col gap-5">
          <SummaryCard wo={wo} invoice={invoice} status={status} />
          {invoice && (
            <BonusCard
              woNumber={wo.wo_number}
              initialOverride={wo.included_in_bonus}
              qboClass={invoice.qbo_class}
            />
          )}
          <PreProcessingCard wo={wo} invoice={invoice} />
          {invoice && <ProcessingCard attempt={processAttempt} />}
        </div>
      </div>
    </>
  )
}
