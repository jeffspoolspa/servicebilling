import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import {
  listBillingFlags,
  listBillingMonths,
  listReviewFlags,
  formatMonth,
  type BillingFlagRow,
  type ReviewFlagRow,
} from "../_lib/queries"
import { MonthSelect } from "../_components/month-select"

export const metadata = { title: "Maintenance · Billing flags" }
export const dynamic = "force-dynamic"

const FLAG_TONE = { HIGH: "coral", WATCH: "sun", SELF_SPIKE: "sun", PCT_SPIKE: "sun" } as const
const AUDIT_TONE = { flagged: "coral", reviewed: "grass", resolved: "teal" } as const

export default async function BillingFlagsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; watch?: string }>
}) {
  const sp = await searchParams
  let months
  try {
    months = await listBillingMonths()
  } catch (e) {
    return (
      <div className="px-7 pt-6 pb-10">
        <Card className="p-8 text-center text-ink-mute text-[13px]">
          Billing data unavailable — apply migration
          20260702130000_maintenance_billing_module_rpcs.sql.
          <div className="mt-2 text-[11px]">{e instanceof Error ? e.message : String(e)}</div>
        </Card>
      </div>
    )
  }
  const monthOptions = months.map((m) => ({
    value: m.billing_month.slice(0, 7),
    label: formatMonth(m.billing_month),
  }))
  const selected =
    monthOptions.find((m) => m.value === sp.month)?.value ??
    monthOptions[0]?.value ??
    new Date().toISOString().slice(0, 7)
  const includeWatch = sp.watch === "1"
  const monthDate = `${selected}-01`

  const [reviewQueue, flags] = await Promise.all([
    listReviewFlags(monthDate),
    listBillingFlags(monthDate, includeWatch),
  ])
  const openHigh = flags.filter((f) => f.audit_status === "flagged" && f.flag_level === "HIGH")
  const groupCounts = new Map<string, number>()
  for (const r of reviewQueue) {
    const g = r.peer_group ?? "?"
    groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1)
  }
  const groupSummary = [...groupCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([g, n]) => `${n} ${g}`)
    .join(" · ")

  return (
    <div className="px-7 pt-6 pb-10 space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-end gap-4">
          <div>
            <h2 className="font-display text-[16px]">Billing review</h2>
            <div className="text-ink-mute text-[12px] mt-0.5">
              {reviewQueue.length} in the 2x-median queue
              {groupSummary && ` (${groupSummary})`} · {openHigh.length} unreviewed HIGH (held
              from autopay + sending)
            </div>
          </div>
          <MonthSelect
            months={
              monthOptions.length > 0 ? monthOptions : [{ value: selected, label: selected }]
            }
            value={selected}
          />
        </div>
        <Link
          href={`/maintenance/billing?month=${selected}` as never}
          className="text-[12px] text-ink-mute hover:text-ink underline underline-offset-2"
        >
          Back to billing months
        </Link>
      </div>

      <section>
        <div className="flex items-center gap-3 mb-2">
          <h3 className="font-display text-[13px] text-ink">
            Review queue — over 2x the group&apos;s clean median
          </h3>
          <span className="text-[11px] text-ink-mute">
            net consumable bill &gt; 2x peer clean median and at least $150; medians exclude
            provides-chems pools. Pool volume not yet normalized — intentionally wide.
          </span>
        </div>
        <Card>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-mute border-b border-line-soft">
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Peer group</th>
                <th className="px-4 py-2 font-medium text-right">Visits</th>
                <th className="px-4 py-2 font-medium text-right">Total $</th>
                <th className="px-4 py-2 font-medium text-right">Group median</th>
                <th className="px-4 py-2 font-medium text-right">x median</th>
                <th className="px-4 py-2 font-medium">Review</th>
              </tr>
            </thead>
            <tbody>
              {reviewQueue.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-ink-mute">
                    Nothing over 2x the clean median for {formatMonth(monthDate)}.
                  </td>
                </tr>
              )}
              {reviewQueue.map((r) => (
                <ReviewRow key={r.customer_id} r={r} month={selected} />
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      <section>
        <div className="flex items-center gap-3 mb-2">
          <h3 className="font-display text-[13px] text-ink">CPV z-score audit flags</h3>
          <span className="text-[11px] text-ink-mute">
            the hold source: an unreviewed HIGH here blocks autopay + sending
          </span>
          <Link
            href={
              `/maintenance/billing/flags?month=${selected}${includeWatch ? "" : "&watch=1"}` as never
            }
          >
            <Pill tone={includeWatch ? "sun" : "neutral"}>
              {includeWatch ? "showing WATCH" : "show WATCH"}
            </Pill>
          </Link>
        </div>
        <Card>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-mute border-b border-line-soft">
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Peer group</th>
                <th className="px-4 py-2 font-medium text-right">Visits</th>
                <th className="px-4 py-2 font-medium text-right">Chem $</th>
                <th className="px-4 py-2 font-medium text-right">CPV</th>
                <th className="px-4 py-2 font-medium text-right">Peer median</th>
                <th className="px-4 py-2 font-medium text-right">Fleet z</th>
                <th className="px-4 py-2 font-medium text-right">Self z</th>
                <th className="px-4 py-2 font-medium">Flag</th>
                <th className="px-4 py-2 font-medium">Review</th>
              </tr>
            </thead>
            <tbody>
              {flags.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-ink-mute">
                    No z-score flags for {formatMonth(monthDate)}. Run the billing audit to
                    populate this list.
                  </td>
                </tr>
              )}
              {flags.map((f) => (
                <FlagRow key={`${f.customer_id}`} f={f} month={selected} />
              ))}
            </tbody>
          </table>
        </Card>
      </section>
    </div>
  )
}

function num(v: number | null, digits = 2): string {
  return v == null ? "—" : Number(v).toFixed(digits)
}

function ReviewRow({ r, month }: { r: ReviewFlagRow; month: string }) {
  return (
    <tr className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]">
      <td className="px-4 py-2.5 text-ink">
        <Link
          href={`/maintenance/billing/flags/${r.customer_id}?month=${month}` as never}
          className="hover:text-cyan"
        >
          {r.customer_name ?? `#${r.customer_id}`}
        </Link>
        {r.provides_chems && (
          <span className="ml-2 text-[10px] text-ink-mute uppercase tracking-wide">
            provides chems
          </span>
        )}
      </td>
      <td className="px-4 py-2.5 text-ink-mute text-[11px]">{r.peer_group ?? "—"}</td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">{num(r.visits, 0)}</td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink">
        {r.total_usd == null ? "—" : formatCurrency(r.total_usd)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
        {r.group_clean_median == null ? "—" : formatCurrency(r.group_clean_median)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono num">
        <span className={r.x_median != null && r.x_median >= 3 ? "text-coral" : "text-sun"}>
          {num(r.x_median, 1)}x
        </span>
      </td>
      <td className="px-4 py-2.5">
        {r.audit_flag_level ? (
          <span className="inline-flex items-center gap-1.5">
            {r.audit_flag_level !== "REVIEW_2X" && (
              <Pill
                tone={FLAG_TONE[r.audit_flag_level as keyof typeof FLAG_TONE] ?? "sun"}
                dot
              >
                {r.audit_flag_level}
              </Pill>
            )}
            {r.audit_status && (
              <Pill tone={AUDIT_TONE[r.audit_status as keyof typeof AUDIT_TONE] ?? "neutral"}>
                {r.audit_status}
              </Pill>
            )}
          </span>
        ) : (
          <span className="text-ink-mute text-[11px]">not reviewed</span>
        )}
      </td>
    </tr>
  )
}

function FlagRow({ f, month }: { f: BillingFlagRow; month: string }) {
  return (
    <tr className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]">
      <td className="px-4 py-2.5 text-ink">
        <Link
          href={`/maintenance/billing/flags/${f.customer_id}?month=${month}` as never}
          className="hover:text-cyan"
        >
          {f.customer_name ?? `#${f.customer_id}`}
        </Link>
      </td>
      <td className="px-4 py-2.5 text-ink-mute text-[11px]">{f.peer_group ?? "—"}</td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">{num(f.visits, 0)}</td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
        {f.chem_usd == null ? "—" : formatCurrency(f.chem_usd)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink">
        {f.cpv == null ? "—" : formatCurrency(f.cpv)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
        {f.peer_median == null ? "—" : formatCurrency(f.peer_median)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">{num(f.fleet_z)}</td>
      <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">{num(f.self_z)}</td>
      <td className="px-4 py-2.5">
        <Pill tone={FLAG_TONE[f.flag_level] ?? "sun"} dot>
          {f.flag_level}
        </Pill>
      </td>
      <td className="px-4 py-2.5">
        <Pill tone={AUDIT_TONE[f.audit_status] ?? "neutral"}>{f.audit_status}</Pill>
        {f.audit_notes && (
          <div
            className="text-[10px] text-ink-mute mt-0.5 max-w-[180px] truncate"
            title={f.audit_notes}
          >
            {f.audit_notes}
          </div>
        )}
      </td>
    </tr>
  )
}
