import Link from "next/link"
import { Card, CardBody } from "@/components/ui/card"
import { SyncAllButton } from "@/components/billing/sync-all-button"
import { SyncWorkOrdersButton } from "@/components/billing/sync-work-orders-button"
import { BillingTabs } from "./billing-tabs"
import { getDashboardKpis } from "@/lib/queries/dashboard"
import { formatCurrency } from "@/lib/utils/format"

export const dynamic = "force-dynamic"

/**
 * Shared layout for every /service-billing/* sub-page.
 *
 * Persistent header above the page content:
 *   1. KPI strip — Awaiting / Ready / Needs Review / Processed. Each
 *      tile is a link to the matching sub-tab. Re-fetched on every
 *      navigation (route change re-runs this Server Component).
 *   2. Sync actions — the two sync buttons (ION + QBO) used to live in
 *      the Topbar; they moved here, subtly.
 *   3. Tabs — Awaiting Invoice / Ready / Needs Review / Processed / Audit.
 *      Shared so sub-pages never duplicate this markup.
 *
 * Per-page content (the Card + table in each sub-page) renders as
 * `children`.
 */
export default async function ServiceBillingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const kpis = await getDashboardKpis()

  return (
    <>
      <div className="px-7 pt-6 pb-4 flex flex-col gap-4">
        <section className="grid grid-cols-4 gap-3.5">
          <KpiTile
            label="Awaiting Invoice"
            value={kpis.awaiting_invoice.toLocaleString()}
            delta={formatCurrency(kpis.awaiting_invoice_total)}
            tone="sun"
            href="/service-billing/awaiting-invoice"
          />
          <KpiTile
            label="Ready to Process"
            value={kpis.ready_to_process.toLocaleString()}
            delta={formatCurrency(kpis.ready_to_process_total)}
            tone="cyan"
            href="/service-billing/queue"
          />
          <KpiTile
            label="Needs Review"
            value={kpis.needs_review.toLocaleString()}
            delta={kpis.needs_review > 0 ? "human eyes required" : "all clear"}
            tone={kpis.needs_review > 0 ? "coral" : "grass"}
            href="/service-billing/needs-attention"
          />
          <KpiTile
            label="Processed MTD"
            value={kpis.processed_mtd.toLocaleString()}
            delta={formatCurrency(kpis.processed_mtd_total)}
            tone="grass"
            href="/service-billing/sent"
          />
        </section>

        <div className="flex items-center gap-2">
          <div className="text-[11px] text-ink-mute">
            Daily billing workflow · refreshed on every page load
          </div>
          <div className="ml-auto flex items-center gap-2">
            <SyncWorkOrdersButton />
            <SyncAllButton />
          </div>
        </div>
      </div>

      <BillingTabs />

      {children}
    </>
  )
}

interface KpiTileProps {
  label: string
  value: string
  delta: string
  tone: "cyan" | "sun" | "grass" | "coral"
  href: string
}

function KpiTile({ label, value, delta, tone, href }: KpiTileProps) {
  const toneClass = {
    cyan: "text-cyan",
    sun: "text-sun",
    grass: "text-grass",
    coral: "text-coral",
  }[tone]
  return (
    <Link href={href as never} className="block">
      <Card className="relative overflow-hidden hover:border-cyan/40 transition-colors cursor-pointer">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(320px_100px_at_100%_0%,rgb(56_189_248_/_0.08),transparent_60%)]" />
        <CardBody>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            {label}
          </div>
          <div className="font-sans num text-[28px] font-semibold tracking-tight mt-1.5 text-ink">
            {value}
          </div>
          <div className={`font-mono text-[11px] mt-1 ${toneClass}`}>
            {delta}
          </div>
        </CardBody>
      </Card>
    </Link>
  )
}
