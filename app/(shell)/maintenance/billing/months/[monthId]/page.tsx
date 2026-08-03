import Link from "next/link"
import { notFound } from "next/navigation"
import { createSupabaseServer } from "@/lib/supabase/server"
import { Pill } from "@/components/ui/pill"
import { StatusStepper } from "@/components/ui/status-stepper"
import { formatCurrency } from "@/lib/utils/format"
import { MONTHS_SELECT, MONTH_STAGES, stepperStage, type MonthOverviewRow } from "../../_lib/months"

/**
 * One month's journey, stage by stage. Unreached stages render as quiet
 * placeholders — the row IS the history, so the page never invents state.
 */

function StageCard({
  title,
  at,
  reached,
  children,
  placeholder,
}: {
  title: string
  at: string | null
  reached: boolean
  children?: React.ReactNode
  placeholder: string
}) {
  return (
    <div className={`rounded-lg border px-4 py-3 ${reached ? "border-line-soft" : "border-line-soft/50 opacity-60"}`}>
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">{title}</span>
        {at ? (
          <span className="font-mono text-[10px] text-ink-mute">
            {new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 text-[12px] text-ink-dim">{reached ? children : <span className="text-ink-mute">{placeholder}</span>}</div>
    </div>
  )
}

export default async function MonthDetailPage({ params }: { params: Promise<{ monthId: string }> }) {
  const { monthId } = await params
  const sb = await createSupabaseServer()
  const { data, error } = await sb.schema("billing").from("v_months_overview").select(MONTHS_SELECT).eq("id", monthId).limit(1)
  if (error) return <div className="p-7 text-sm text-coral">month read failed: {String(error.message ?? error)}</div>
  const m = (data ?? [])[0] as MonthOverviewRow | undefined
  if (!m) notFound()

  const monthLabel = m.month.slice(0, 7)
  const invoices = m.issued_invoices ?? []
  const DOC_LABEL: Record<string, string> = { service: "Service", consumables: "Consumables", green: "Green pool" }

  return (
    <div className="px-7 pt-6 pb-10 space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">Billing month · {monthLabel}</div>
          <h2 className="font-display text-[18px] mt-0.5">{m.customer_name ?? m.customer_id}</h2>
        </div>
        <div className="flex items-center gap-3 text-[12px]">
          {m.open_findings > 0 && (
            <Link
              href={`/maintenance/billing/findings/${m.customer_id}?month=${monthLabel}` as never}
              className="text-sun hover:brightness-110 underline underline-offset-2"
            >
              {m.open_findings} open finding{m.open_findings === 1 ? "" : "s"}
            </Link>
          )}
          <Link href={`/maintenance/billing/months` as never} className="text-ink-mute hover:text-ink underline underline-offset-2">
            Back to months
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <StatusStepper stages={[...MONTH_STAGES]} current={stepperStage(m.status)} className="max-w-[560px]" />
        {m.status === "disputed" && <Pill tone="coral">disputed</Pill>}
        {m.status === "held" && <Pill tone="sun">held</Pill>}
        <span className="ml-auto font-mono num text-[17px] text-ink">{formatCurrency(m.subtotal_cents / 100)}</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <StageCard title="Accrue" at={null} reached={m.item_count > 0} placeholder="No sources claimed yet.">
          {m.item_count} item{m.item_count === 1 ? "" : "s"} claimed · subtotal{" "}
          <span className="font-mono num text-ink">{formatCurrency(m.subtotal_cents / 100)}</span>
        </StageCard>

        <StageCard title="Reconcile" at={m.reconciled_at ?? m.disputed_at} reached={m.reconciled_at !== null || m.disputed_at !== null} placeholder="Not reconciled yet — the report comparison runs after accrual.">
          {m.reconciled_at ? (
            "Our totals agree with ION's own report."
          ) : (
            <span className="text-coral">Disputed: {(m.disputes ?? []).join("; ") || "totals disagree"}</span>
          )}
        </StageCard>

        <StageCard title="Gate" at={m.gated_at} reached={m.gated_at !== null} placeholder="Not gated yet — the pre-invoice checks run after reconciliation.">
          {(m.gate_held_for ?? []).length === 0 ? (
            "All criteria cleared."
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {(m.gate_held_for ?? []).map((h) => (
                <Pill key={h} tone="sun">
                  {h}
                </Pill>
              ))}
            </span>
          )}
        </StageCard>

        <StageCard title="Invoice" at={m.invoiced_at} reached={m.invoiced_at !== null} placeholder="No invoice yet — issue follows a clean gate once the month is over.">
          {invoices.length === 0 ? (
            "Marked invoiced."
          ) : (
            <div className="space-y-1">
              {invoices.map((inv) => (
                <div key={inv.qbo_invoice_id} className="flex items-center gap-2">
                  <Pill tone="cyan">{DOC_LABEL[inv.kind] ?? inv.kind}</Pill>
                  <span className="font-mono text-[11px]">#{inv.doc_number}</span>
                  <span className="font-mono num ml-auto">{formatCurrency(inv.subtotal_cents / 100)}</span>
                </div>
              ))}
            </div>
          )}
        </StageCard>

        <StageCard title="Preprocess" at={m.preprocessed_at} reached={m.preprocessed_at !== null} placeholder="Not preprocessed — credits and the payment route resolve after the invoice exists.">
          {m.linked_payment_method_id ? (
            <span>
              Route: <Pill tone="grass">autopay</Pill> <span className="font-mono text-[10px] text-ink-mute ml-1">{m.linked_payment_method_id}</span>
            </span>
          ) : (
            <span>
              Route: <Pill tone="neutral">email</Pill> — no active instrument on the roster
            </span>
          )}
        </StageCard>

        <StageCard title="Process" at={m.sent_at} reached={m.sent_at !== null} placeholder="Not processed — charge (if routed) and send come last.">
          Sent to the customer{m.linked_payment_method_id ? " after collection" : " (email route)"}.
        </StageCard>
      </div>
    </div>
  )
}
