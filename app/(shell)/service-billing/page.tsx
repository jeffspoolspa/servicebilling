import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Tabs } from "@/components/shell/tabs"
import { Card, CardBody } from "@/components/ui/card"
import { BarChart3 } from "lucide-react"

export default function ServiceBillingPage() {
  return (
    <>
      <Topbar crumbs={[{ label: "Service Billing" }]} />
      <ObjectHeader
        eyebrow="Module"
        title="Service Billing"
        sub="Daily billing workflow for completed work orders"
        icon={<BarChart3 className="w-6 h-6" strokeWidth={1.8} />}
      />
      <Tabs
        items={[
          { href: "/service-billing", label: "Overview" },
          { href: "/service-billing/queue", label: "Billing Queue" },
          { href: "/service-billing/needs-attention", label: "Needs Attention" },
          { href: "/service-billing/revenue", label: "Revenue" },
          { href: "/service-billing/activity", label: "Activity" },
        ]}
      />
      <div className="px-7 py-6">
        <Card>
          <CardBody className="text-ink-dim text-sm">
            Service billing module home — overview of pending work, recent processing runs, KPIs.
          </CardBody>
        </Card>
      </div>
    </>
  )
}
