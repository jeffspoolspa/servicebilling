import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Tabs } from "@/components/shell/tabs"
import { Card, CardBody } from "@/components/ui/card"
import { BarChart3 } from "lucide-react"

export default function QueuePage() {
  return (
    <>
      <Topbar
        crumbs={[
          { label: "Service Billing", href: "/service-billing" },
          { label: "Billing Queue" },
        ]}
      />
      <ObjectHeader
        eyebrow="Service Billing"
        title="Billing Queue"
        sub="Invoices ready to send · grouped by customer"
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
            Wire up: pull from{" "}
            <code className="text-cyan font-mono">listInvoices()</code> in{" "}
            <code className="text-cyan font-mono">lib/entities/invoice/queries.ts</code>{" "}
            filtered to <code className="text-cyan font-mono">billing_status = &apos;matched&apos;</code>.
          </CardBody>
        </Card>
      </div>
    </>
  )
}
