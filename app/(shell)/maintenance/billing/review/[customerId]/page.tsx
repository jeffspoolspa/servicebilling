import Link from "next/link"
import { notFound } from "next/navigation"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import {
  getCustomerMonth,
  listBillingFlags,
  listFlagItems,
  listReviewFlags,
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

  const [flags, reviewQueue, items, cm] = await Promise.all([
    listBillingFlags(monthDate, true),
    listReviewFlags(monthDate),
    listFlagItems(customerId, monthDate),
    getCustomerMonth(customerId, monthDate),
  ])
  const flag = flags.find((f) => f.customer_id === customerId)
  const review = reviewQueue.find((r) => r.customer_id === customerId)
  if (!flag && !review && !cm) notFound()

  const name = flag?.customer_name ?? review?.customer_name ?? `Customer #${customerId}`
  const peerGroup = flag?.peer_group ?? review?.peer_group ?? cm?.peer_group ?? "—"
  // review state may exist on either surface: a z-audit row or a REVIEW_2X row
  const auditStatus = flag?.audit_status ?? review?.audit_status ?? null
  const auditNote = flag?.audit_notes ?? review?.audit_notes ?? null
  const isHold = flag?.flag_level === "HIGH" && flag.audit_status === "flagged"
  const usd = (v: number | null | undefined) => (v == null ? "—" : formatCurrency(Number(v)))

  const breakdown: { label: string; value: number | null | undefined }[] = [
    { label: "Core", value: cm?.core_usd },
    { label: "Specialty", value: cm?.specialty_usd },
    { label: "Spa", value: cm?.spa_usd },
    { label: "Testing", value: cm?.testing_usd },
    { label: "Parts", value: cm?.parts_usd },
    { label: "Extra service", value: cm?.extra_service_usd },
    { label: "Discounts", value: cm?.discount_usd },
  ]

  return (
    <div className="px-7 pt-6 pb-10 space-y-4 max-w-5xl">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            Billing review · {formatMonth(monthDate)}
          </div>
          <h2 className="font-display text-[18px] mt-0.5">{name}</h2>
          <div className="flex items-center gap-2 mt-1.5">
            {review && (
              <Pill tone={review.x_median != null && review.x_median >= 3 ? "coral" : "sun"} dot>
                {review.x_median != null
                  ? `${Number(review.x_median).toFixed(1)}x group median`
                  : "2x-median queue"}
              </Pill>
            )}
            {flag && (
              <Pill tone={flag.flag_level === "HIGH" ? "coral" : "sun"} dot>
                {flag.flag_level}
              </Pill>
            )}
            {auditStatus && (
              <Pill tone={AUDIT_TONE[auditStatus as keyof typeof AUDIT_TONE] ?? "neutral"}>
                {auditStatus}
              </Pill>
            )}
            <span className="text-[11px] text-ink-mute">
              {peerGroup}
              {(review?.provides_chems ?? cm?.provides_chems) && " · provides chems"}
            </span>
          </div>
        </div>
        <Link
          href={`/maintenance/billing/review?month=${month}` as never}
          className="text-[12px] text-ink-mute hover:text-ink underline underline-offset-2"
        >
          Back to review
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Stat label="Visits" value={fmtInt(cm?.visits ?? flag?.visits ?? review?.visits)} />
        {review ? (
          <>
            <Stat label="Total consumables $" value={usd(review.total_usd)} accent />
            <Stat label="Group clean median" value={usd(review.group_clean_median)} />
          </>
        ) : (
          <Stat label="Chem $" value={usd(cm?.chem_usd ?? flag?.chem_usd)} />
        )}
        <Stat label="CPV" value={usd(cm?.cpv ?? flag?.cpv)} accent={!review} />
        {flag && (
          <>
            <Stat label="Peer median CPV" value={usd(flag.peer_median)} />
            <Stat label="Fleet z" value={flag.fleet_z != null ? Number(flag.fleet_z).toFixed(2) : "—"} />
          </>
        )}
      </div>

      {cm && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat
            label={`Avg FC (${cm.reading_count} readings)`}
            value={cm.avg_fc != null ? `${cm.avg_fc} ppm` : "—"}
          />
          <Stat label="Avg pH" value={cm.avg_ph != null ? String(cm.avg_ph) : "—"} />
          <Stat label="Avg CYA" value={cm.avg_cya != null ? `${cm.avg_cya} ppm` : "—"} />
          <Card className="px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-ink-mute">
              Category breakdown
            </div>
            <div className="text-[11px] font-mono num text-ink-dim mt-1 leading-5">
              {breakdown
                .filter((b) => b.value != null && Number(b.value) !== 0)
                .map((b) => `${b.label} ${usd(b.value)}`)
                .join(" · ") || "—"}
            </div>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {`Per-item usage — ${formatMonth(monthDate)} vs this customer's usual month vs peers`}
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
                it.month_usd != null && it.usual_usd != null && Number(it.usual_usd) > 0
                  ? Number(it.month_usd) / Number(it.usual_usd)
                  : null
              return (
                <tr
                  key={it.item_name}
                  className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]"
                >
                  <td className="px-4 py-2 text-ink">{it.item_name}</td>
                  <td className="px-4 py-2 text-ink-mute text-[11px]">{it.category ?? "—"}</td>
                  <td className="px-4 py-2 text-right font-mono num text-ink-dim">
                    {it.month_qty != null ? Number(it.month_qty) : "—"}
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
                      <span
                        className={
                          ratio >= 2 ? "text-coral" : ratio >= 1.3 ? "text-sun" : "text-ink-mute"
                        }
                      >
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
            spend among {peerGroup} customers who used the item this month. Recurring
            tasks only — same scope as the CPV audit. Pool volume is not yet normalized.
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Review</CardTitle>
        </CardHeader>
        <CardBody>
          {isHold && (
            <div className="text-[12px] text-coral mb-3">
              This customer-month is held from autopay and invoice sending until reviewed.
            </div>
          )}
          <ReviewActions
            customerId={customerId}
            month={monthDate}
            currentStatus={auditStatus}
            currentNote={auditNote}
            isHold={isHold}
          />
        </CardBody>
      </Card>
    </div>
  )
}

function fmtInt(v: number | null | undefined): string {
  return v == null ? "—" : Number(v).toFixed(0)
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
