import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Waves } from "lucide-react"

const kpis = [
  { label: "Ready to Process", value: "23", delta: "+6 since yesterday", tone: "grass" },
  { label: "Needs Attention", value: "7", delta: "3 credit · 2 subtotal · 2 class.", tone: "sun" },
  { label: "Revenue · Week", value: "$48,214", delta: "+12.4% vs last week", tone: "grass" },
  { label: "Collected · MTD", value: "$162,907", delta: "87% of sent", tone: "grass" },
] as const

export default function HomePage() {
  return (
    <>
      <Topbar crumbs={[{ label: "Home" }, { label: "Dashboard" }]} />

      <ObjectHeader
        eyebrow="Service Billing · Dashboard"
        title="Good morning, Carter."
        sub="23 invoices ready to send · 7 need your eyes · last QBO sync 4 min ago"
        icon={<Waves className="w-6 h-6" strokeWidth={1.8} />}
      />

      <div className="px-7 py-6 flex flex-col gap-6">
        <section className="grid grid-cols-4 gap-3.5">
          {kpis.map((k, i) => (
            <Card
              key={k.label}
              className="relative overflow-hidden animate-fadeup"
              style={{ animationDelay: `${i * 0.05}s` }}
            >
              <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(400px_120px_at_100%_0%,rgb(56_189_248_/_0.09),transparent_60%)]" />
              <CardBody>
                <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">
                  {k.label}
                </div>
                <div className="font-sans num text-[34px] font-semibold tracking-tight mt-2 text-ink">
                  {k.value}
                </div>
                <div
                  className={`font-mono text-[11px] mt-1.5 ${k.tone === "sun" ? "text-sun" : "text-grass"}`}
                >
                  {k.delta}
                </div>
              </CardBody>
            </Card>
          ))}
        </section>

        <section className="grid grid-cols-[2fr_1fr] gap-5">
          <Card className="animate-fadeup" style={{ animationDelay: "0.1s" }}>
            <CardHeader>
              <CardTitle>Billing Queue</CardTitle>
              <Pill className="ml-auto">23 ready</Pill>
            </CardHeader>
            <div className="px-5 py-4 text-ink-dim text-sm">
              Wire up: pull from <code className="text-cyan font-mono">billing.invoices</code>{" "}
              where{" "}
              <code className="text-cyan font-mono">work_orders.billing_status = &apos;matched&apos;</code>
              .
            </div>
          </Card>

          <Card className="animate-fadeup" style={{ animationDelay: "0.15s" }}>
            <CardHeader>
              <CardTitle>Revenue by Tech</CardTitle>
              <Pill className="ml-auto">This month</Pill>
            </CardHeader>
            <div className="px-5 py-4 text-ink-dim text-sm">
              Wire up:{" "}
              <code className="text-cyan font-mono">billing.v_revenue_by_employee</code>
            </div>
          </Card>
        </section>
      </div>
    </>
  )
}
