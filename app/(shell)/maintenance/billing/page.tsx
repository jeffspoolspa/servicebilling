import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import {
  listBillingMonths,
  listBillingPeriods,
  formatMonth,
  type BillingPeriodRow,
  type ProcessingStatus,
} from "./_lib/queries"
import { MonthSelect } from "./_components/month-select"
import { RunActions } from "./_components/run-actions"

export const metadata = { title: "Maintenance · Billing" }
export const dynamic = "force-dynamic"

const STATUS_TONE: Record<ProcessingStatus, "neutral" | "cyan" | "sun" | "grass"> = {
  pending: "neutral",
  synced_to_qbo: "cyan",
  processed: "sun",
  paid: "grass",
}
const STATUS_LABEL: Record<ProcessingStatus, string> = {
  pending: "pending",
  synced_to_qbo: "synced to QBO",
  processed: "processed",
  paid: "paid",
}
const STATUSES: ProcessingStatus[] = ["pending", "synced_to_qbo", "processed", "paid"]

const ION_TONE = { match: "grass", mismatch: "coral", missing: "neutral" } as const

function cents(v: number | null | undefined): string {
  return v == null ? "—" : formatCurrency(v / 100)
}

export default async function MaintenanceBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; status?: string; hold?: string; q?: string }>
}) {
  const sp = await searchParams
  let months
  try {
    months = await listBillingMonths()
  } catch (e) {
    // Deploy-before-migration gap: the maint_billing_* RPCs don't exist yet
    return (
      <div className="px-7 pt-6 pb-10">
        <Card className="p-8 text-center text-ink-mute text-[13px]">
          Billing data unavailable — apply migration
          20260702100000_maintenance_billing_module_rpcs.sql.
          <div className="mt-2 text-[11px]">{e instanceof Error ? e.message : String(e)}</div>
        </Card>
      </div>
    )
  }

  if (months.length === 0) {
    return (
      <div className="px-7 pt-6 pb-10">
        <Card className="p-8 text-center text-ink-mute text-[13px]">
          No billing periods yet — run f/billing_audit/build_task_billing_periods first.
        </Card>
      </div>
    )
  }

  const monthOptions = months.map((m) => ({
    value: m.billing_month.slice(0, 7),
    label: formatMonth(m.billing_month),
  }))
  const selected =
    monthOptions.find((m) => m.value === sp.month)?.value ?? monthOptions[0].value
  const monthDate = `${selected}-01`
  const monthMeta = months.find((m) => m.billing_month.slice(0, 7) === selected)!

  const all = await listBillingPeriods(monthDate)

  const statusFilter = STATUSES.includes(sp.status as ProcessingStatus)
    ? (sp.status as ProcessingStatus)
    : undefined
  const holdOnly = sp.hold === "1"
  const q = (sp.q ?? "").trim().toLowerCase()

  const rows = all.filter(
    (r) =>
      (!statusFilter || r.processing_status === statusFilter) &&
      (!holdOnly || r.high_flag_hold) &&
      (!q || (r.customer_name ?? "").toLowerCase().includes(q)),
  )

  const counts: Record<ProcessingStatus, number> = {
    pending: 0,
    synced_to_qbo: 0,
    processed: 0,
    paid: 0,
  }
  let holdCount = 0
  let ionMismatch = 0
  for (const r of all) {
    counts[r.processing_status]++
    if (r.high_flag_hold) holdCount++
    if (r.ion_match === "mismatch") ionMismatch++
  }

  const baseParams = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams()
    const merged = { month: selected, status: sp.status, hold: sp.hold, q: sp.q, ...over }
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v)
    return `/maintenance/billing?${p.toString()}` as never
  }

  return (
    <div className="px-7 pt-6 pb-10 space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-end gap-4">
          <div>
            <h2 className="font-display text-[16px]">Billing months</h2>
            <div className="text-ink-mute text-[12px] mt-0.5">
              {monthMeta.period_count.toLocaleString()} invoice promises ·{" "}
              {cents(monthMeta.expected_total_cents)} expected
              {monthMeta.locked && " · month locked"}
            </div>
          </div>
          <MonthSelect months={monthOptions} value={selected} />
        </div>
        <RunActions
          month={selected}
          monthLabel={formatMonth(monthDate)}
          holdCount={monthMeta.high_hold_customers}
        />
      </div>

      {holdCount > 0 && (
        <Card className="px-4 py-3 border-coral/30 bg-coral/5 flex items-center justify-between">
          <div className="text-[13px] text-coral">
            {monthMeta.high_hold_customers} customer-month(s) have an unreviewed HIGH
            billing-audit flag — held from autopay and invoice sending ({holdCount}{" "}
            period{holdCount === 1 ? "" : "s"} affected).
          </div>
          <Link
            href={`/maintenance/billing/flags?month=${selected}` as never}
            className="text-[12px] text-coral underline underline-offset-2 shrink-0"
          >
            Review flags
          </Link>
        </Card>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Link href={baseParams({ status: undefined, hold: undefined })}>
          <Pill tone={!statusFilter && !holdOnly ? "cyan" : "neutral"}>
            all {all.length}
          </Pill>
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={baseParams({ status: s, hold: undefined })}>
            <Pill tone={statusFilter === s ? STATUS_TONE[s] : "neutral"} dot>
              {STATUS_LABEL[s]} {counts[s]}
            </Pill>
          </Link>
        ))}
        <Link href={baseParams({ status: undefined, hold: "1" })}>
          <Pill tone={holdOnly ? "coral" : "neutral"} dot>
            holds {holdCount}
          </Pill>
        </Link>
        {ionMismatch > 0 && (
          <span className="text-[11px] text-ink-mute ml-2">
            {ionMismatch} ION amount mismatch{ionMismatch === 1 ? "" : "es"}
          </span>
        )}
      </div>

      <Card>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">Task</th>
              <th className="px-4 py-2 font-medium text-right">Visits</th>
              <th className="px-4 py-2 font-medium text-right">Labor</th>
              <th className="px-4 py-2 font-medium text-right">Chems</th>
              <th className="px-4 py-2 font-medium text-right">Expected</th>
              <th className="px-4 py-2 font-medium text-right">ION invoice</th>
              <th className="px-4 py-2 font-medium">QBO invoice</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-ink-mute">
                  No billing periods match this filter.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <PeriodRow key={r.id} r={r} month={selected} />
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

function PeriodRow({ r, month }: { r: BillingPeriodRow; month: string }) {
  return (
    <tr className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02] align-top">
      <td className="px-4 py-2.5 text-ink">
        {r.high_flag_hold && r.customer_id ? (
          <Link
            href={`/maintenance/billing/flags/${r.customer_id}?month=${month}` as never}
            className="hover:text-coral"
          >
            {r.customer_name ?? "(unknown)"}
          </Link>
        ) : (
          (r.customer_name ?? <span className="text-ink-mute">(unknown)</span>)
        )}
        {r.on_autopay && (
          <div className="text-[10px] text-ink-mute uppercase tracking-wide">autopay</div>
        )}
      </td>
      <td className="px-4 py-2.5 text-ink-dim">
        {r.service_name ?? "—"}
        <div className="text-[10px] text-ink-mute">
          {[r.category, r.frequency].filter(Boolean).join(" · ") || "—"}
        </div>
      </td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
        {r.billable_visit_count}
      </td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
        {cents(r.expected_labor_cents)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
        {cents(r.expected_consumable_cents)}
        {r.unpriced_count > 0 && (
          <div className="text-[10px] text-sun font-sans">{r.unpriced_count} unpriced</div>
        )}
      </td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink">
        {cents(r.expected_total_cents)}
      </td>
      <td className="px-4 py-2.5 text-right">
        <span className="font-mono num text-ink-dim">{cents(r.ion_amt_cents)}</span>
        <div className="mt-0.5">
          <Pill tone={ION_TONE[r.ion_match]}>{r.ion_match}</Pill>
        </div>
      </td>
      <td className="px-4 py-2.5 text-ink-dim">
        {r.qbo_doc_number ? (
          <>
            <span className="font-mono text-xs">#{r.qbo_doc_number}</span>
            <div className="text-[10px] text-ink-mute">
              {r.qbo_balance != null && r.qbo_balance > 0
                ? `${formatCurrency(r.qbo_balance)} due`
                : "paid"}
            </div>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-4 py-2.5">
        <div className="flex flex-col items-start gap-1">
          <Pill tone={STATUS_TONE[r.processing_status]} dot>
            {STATUS_LABEL[r.processing_status]}
          </Pill>
          {r.high_flag_hold && (
            <Pill tone="coral" dot>
              HIGH-flag hold
            </Pill>
          )}
          {r.reconcile_status === "mismatch" && <Pill tone="coral">reconcile mismatch</Pill>}
        </div>
      </td>
    </tr>
  )
}
