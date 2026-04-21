import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Waves, AlertTriangle } from "lucide-react"
import Link from "next/link"
import { getDashboardKpis, getBillingQueue, getNeedsReview } from "@/lib/queries/dashboard"
import { formatCurrency, formatRelative } from "@/lib/utils/format"

export const dynamic = "force-dynamic"

export default async function HomePage() {
  const [kpis, queueResult, needsReviewRows] = await Promise.all([
    getDashboardKpis(),
    getBillingQueue({ status: "ready_to_process", limit: 8 }),
    getNeedsReview(6),
  ])
  const recentQueue = queueResult.rows

  return (
    <>
      <Topbar crumbs={[{ label: "Home" }, { label: "Dashboard" }]} />

      <ObjectHeader
        eyebrow="Service Billing · Live"
        title="Good morning, Carter."
        sub={`${kpis.ready_to_process.toLocaleString()} ready to process · ${kpis.awaiting_invoice} awaiting invoice · ${kpis.needs_review} need review · ${formatCurrency(kpis.total_billable_value)} in pipeline`}
        icon={<Waves className="w-6 h-6" strokeWidth={1.8} />}
      />

      <div className="px-7 py-6 flex flex-col gap-6">
        {(kpis.audit_billable_zero_subtotal > 0 || kpis.audit_non_billable_with_charges > 0) && (
          <Link
            href={"/service-billing/audit" as never}
            className="flex items-center gap-3 rounded-lg border border-sun/20 bg-sun/5 px-4 py-2.5 hover:border-sun/40 transition-colors"
          >
            <AlertTriangle className="w-4 h-4 text-sun" strokeWidth={2} />
            <div className="text-[12px] text-ink-dim flex-1">
              <span className="text-sun font-medium">Audit:</span>{" "}
              {kpis.audit_billable_zero_subtotal > 0 && (
                <>{kpis.audit_billable_zero_subtotal} billable WOs with $0 subtotal</>
              )}
              {kpis.audit_billable_zero_subtotal > 0 &&
                kpis.audit_non_billable_with_charges > 0 &&
                " · "}
              {kpis.audit_non_billable_with_charges > 0 && (
                <>{kpis.audit_non_billable_with_charges} non-billable WOs with charges</>
              )}
            </div>
            <span className="text-[11px] text-cyan">Review →</span>
          </Link>
        )}

        <section className="grid grid-cols-4 gap-3.5">
          <KpiCard
            label="Ready to Process"
            value={kpis.ready_to_process.toLocaleString()}
            delta={formatCurrency(kpis.ready_to_process_total)}
            tone="cyan"
            href="/service-billing/queue"
            delay={0}
          />
          <KpiCard
            label="Awaiting Invoice"
            value={kpis.awaiting_invoice.toLocaleString()}
            delta={formatCurrency(kpis.awaiting_invoice_total)}
            tone="sun"
            href="/service-billing/awaiting-invoice"
            delay={1}
          />
          <KpiCard
            label="Needs Review"
            value={kpis.needs_review.toLocaleString()}
            delta={kpis.needs_review > 0 ? "human eyes required" : "all clear"}
            tone={kpis.needs_review > 0 ? "coral" : "grass"}
            href="/service-billing/needs-attention"
            delay={2}
          />
          <KpiCard
            label="Processed"
            value={kpis.processed_mtd.toLocaleString()}
            delta={formatCurrency(kpis.processed_mtd_total)}
            tone="grass"
            href="/service-billing/sent"
            delay={3}
          />
        </section>

        <section className="grid grid-cols-[2fr_1fr] gap-5">
          <Card className="animate-fadeup" style={{ animationDelay: "0.1s" }}>
            <CardHeader>
              <CardTitle>Ready to Process</CardTitle>
              <Pill tone="cyan" className="ml-auto">
                {kpis.ready_to_process.toLocaleString()} · {formatCurrency(kpis.ready_to_process_total)}
              </Pill>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-ink-mute border-b border-line-soft">
                    <th className="px-5 py-2.5 font-medium">WO</th>
                    <th className="font-medium">Customer</th>
                    <th className="font-medium">Type</th>
                    <th className="font-medium">Tech</th>
                    <th className="font-medium">Completed</th>
                    <th className="font-medium num text-right pr-5">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {recentQueue.map((row) => (
                    <tr
                      key={row.wo_number}
                      className="border-b border-line-soft hover:bg-white/[0.03] transition-colors"
                    >
                      <td className="px-5 py-2.5 font-mono">
                        <Link
                          href={`/work-orders/${row.wo_number}` as never}
                          className="text-cyan hover:underline"
                        >
                          {row.wo_number}
                        </Link>
                      </td>
                      <td className="text-ink truncate max-w-[200px]">{row.customer ?? "—"}</td>
                      <td className="text-ink-dim text-xs">{row.type}</td>
                      <td className="text-ink-mute text-xs font-mono">
                        {row.assigned_to?.split(",")[1]?.trim() ?? row.assigned_to ?? "—"}
                      </td>
                      <td className="text-ink-mute text-xs">{formatRelative(row.completed)}</td>
                      <td className="num text-right pr-5 text-ink">
                        {formatCurrency(Number(row.total_due ?? 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {recentQueue.length === 0 && (
                <div className="px-5 py-8 text-center text-ink-mute text-sm">
                  No work orders need classification right now.
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-line-soft">
              <Link
                href="/service-billing/queue"
                className="text-[12px] text-cyan hover:underline"
              >
                View all {kpis.ready_to_process.toLocaleString()} →
              </Link>
            </div>
          </Card>

          <Card className="animate-fadeup" style={{ animationDelay: "0.15s" }}>
            <CardHeader>
              <CardTitle>Needs Review</CardTitle>
              <Pill tone="coral" className="ml-auto">
                {kpis.needs_review}
              </Pill>
            </CardHeader>
            <div className="px-5 py-3 text-[11px] text-ink-mute border-b border-line-soft">
              Subtotal mismatches, unmatched credits, or non-billable WOs with charges.
            </div>
            <div className="flex flex-col">
              {needsReviewRows.map((row) => (
                <div
                  key={row.wo_number}
                  className="px-5 py-2.5 border-b border-line-soft last:border-b-0 hover:bg-white/[0.03] transition-colors"
                >
                  <div className="flex justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <Link href={`/work-orders/${row.wo_number}` as never} className="font-mono text-[11px] text-cyan hover:underline">{row.wo_number}</Link>
                      <div className="text-[12px] text-ink truncate">{row.customer}</div>
                      <div className="text-[10px] text-sun truncate">{row.needs_review_reason}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-[12px] num text-ink">
                        {formatCurrency(Number(row.total_due ?? 0))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-line-soft">
              <Link href="/service-billing/needs-attention" className="text-[12px] text-cyan hover:underline">
                View all {kpis.needs_review} →
              </Link>
            </div>
          </Card>
        </section>
      </div>
    </>
  )
}

interface KpiCardProps {
  label: string
  value: string
  delta: string
  tone: "cyan" | "sun" | "grass" | "coral"
  href: string
  delay: number
}

function KpiCard({ label, value, delta, tone, href, delay }: KpiCardProps) {
  const toneClass = { cyan: "text-cyan", sun: "text-sun", grass: "text-grass", coral: "text-coral" }[tone]
  return (
    <Link href={href as never}>
      <Card
        className="relative overflow-hidden animate-fadeup hover:border-cyan/40 transition-colors cursor-pointer"
        style={{ animationDelay: `${delay * 0.05}s` }}
      >
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(400px_120px_at_100%_0%,rgb(56_189_248_/_0.09),transparent_60%)]" />
        <CardBody>
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">{label}</div>
          <div className="font-sans num text-[34px] font-semibold tracking-tight mt-2 text-ink">
            {value}
          </div>
          <div className={`font-mono text-[11px] mt-1.5 ${toneClass}`}>{delta}</div>
        </CardBody>
      </Card>
    </Link>
  )
}
