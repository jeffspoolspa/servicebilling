import Link from "next/link"
import { notFound } from "next/navigation"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import {
  listBillingFlags,
  listFlagItems,
  formatMonth,
} from "../../_lib/queries"
import { ReviewActions } from "../../_components/review-actions"

export const metadata = { title: "Maintenance · Flag review" }
export const dynamic = "force-dynamic"

const AUDIT_TONE = { flagged: "coral", reviewed: "grass", resolved: "teal" } as const

export default async function FlagDrilldownPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>
  searchParams: Promise<{ month?: string }>
}) {
  const { customerId: rawId } = await params
  const { month } = await searchParams
  const customerId = parseInt(rawId, 10)
  if (!customerId || !month || !/^\d{4}-\d{2}$/.test(month)) notFound()
  const monthDate = `${month}-01`

  const [flags, items] = await Promise.all([
    listBillingFlags(monthDate, true),
    listFlagItems(customerId, monthDate),
  ])
  const flag = flags.find((f) => f.customer_id === customerId)
  if (!flag) notFound()

  const usd = (v: number | null) => (v == null ? "—" : formatCurrency(v))

  return (
    <div className="px-7 pt-6 pb-10 space-y-4 max-w-5xl">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            Billing-audit flag · {formatMonth(monthDate)}
          </div>
          <h2 className="font-display text-[18px] mt-0.5">
            {flag.customer_name ?? `Customer #${customerId}`}
          </h2>
          <div className="flex items-center gap-2 mt-1.5">
            <Pill tone={flag.flag_level === "HIGH" ? "coral" : "sun"} dot>
              {flag.flag_level}
            </Pill>
            <Pill tone={AUDIT_TONE[flag.audit_status] ?? "neutral"}>{flag.audit_status}</Pill>
            <span className="text-[11px] text-ink-mute">
              {flag.peer_group} · {flag.season}
            </span>
          </div>
        </div>
        <Link
          href={`/maintenance/billing/flags?month=${month}` as never}
          className="text-[12px] text-ink-mute hover:text-ink underline underline-offset-2"
        >
          Back to flags
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Stat label="Visits" value={flag.visits?.toFixed(0) ?? "—"} />
        <Stat label="Chem $" value={usd(flag.chem_usd)} />
        <Stat label="CPV" value={usd(flag.cpv)} accent />
        <Stat label="Peer median CPV" value={usd(flag.peer_median)} />
        <Stat label="Fleet z" value={flag.fleet_z?.toFixed(2) ?? "—"} />
        <Stat label="Self z" value={flag.self_z?.toFixed(2) ?? "—"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Per-item usage — {formatMonth(monthDate)} vs this customer&apos;s usual month vs
            peers
          </CardTitle>
        </CardHeader>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              <th className="px-4 py-2 font-medium">Item</th>
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 font-medium text-right">Qty</th>
              <th className="px-4 py-2 font-medium text-right">This month $</th>
              <th className="px-4 py-2 font-medium text-right">Usual month $</th>
              <th className="px-4 py-2 font-medium text-right">Peer avg $</th>
              <th className="px-4 py-2 font-medium text-right">vs usual</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-ink-mute">
                  No consumable usage recorded for this customer-month.
                </td>
              </tr>
            )}
            {items.map((it) => {
              const ratio =
                it.month_usd != null && it.usual_usd != null && it.usual_usd > 0
                  ? it.month_usd / it.usual_usd
                  : null
              return (
                <tr
                  key={it.item_name}
                  className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]"
                >
                  <td className="px-4 py-2 text-ink">{it.item_name}</td>
                  <td className="px-4 py-2 text-ink-mute text-[11px]">{it.category ?? "—"}</td>
                  <td className="px-4 py-2 text-right font-mono num text-ink-dim">
                    {it.month_qty ?? "—"}
                    {it.usual_qty != null && (
                      <span className="text-ink-mute"> / {Number(it.usual_qty).toFixed(1)}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-mono num text-ink">
                    {usd(it.month_usd)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono num text-ink-dim">
                    {usd(it.usual_usd)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono num text-ink-dim">
                    {usd(it.peer_avg_usd)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono num">
                    {ratio == null ? (
                      <span className="text-ink-mute">new</span>
                    ) : (
                      <span className={ratio >= 2 ? "text-coral" : ratio >= 1.3 ? "text-sun" : "text-ink-mute"}>
                        {ratio.toFixed(1)}x
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <CardBody>
          <div className="text-[11px] text-ink-mute">
            Qty shows this month / usual-month average. &quot;Usual month&quot; = this
            customer&apos;s average over the prior 12 months; &quot;peer avg&quot; = average
            spend among {flag.peer_group} customers who used the item this month. Recurring
            tasks only — same scope as the CPV audit.
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Review</CardTitle>
        </CardHeader>
        <CardBody>
          {flag.flag_level === "HIGH" && flag.audit_status === "flagged" && (
            <div className="text-[12px] text-coral mb-3">
              This customer-month is held from autopay and invoice sending until reviewed.
            </div>
          )}
          <ReviewActions
            customerId={customerId}
            month={monthDate}
            currentStatus={flag.audit_status}
            currentNote={flag.audit_notes}
          />
        </CardBody>
      </Card>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-ink-mute">{label}</div>
      <div className={`font-mono num text-[15px] mt-1 ${accent ? "text-coral" : "text-ink"}`}>
        {value}
      </div>
    </Card>
  )
}
