import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Tabs } from "@/components/shell/tabs"
import { Card, CardBody } from "@/components/ui/card"
import { Users } from "lucide-react"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function CustomerDetailPage({ params }: PageProps) {
  const { id } = await params

  return (
    <>
      <Topbar crumbs={[{ label: "Customers", href: "/customers" }, { label: id }]} />
      <ObjectHeader
        eyebrow="Customer"
        title="Customer Name"
        sub={`ID ${id} · QBO 12345 · Active autopay`}
        icon={<Users className="w-6 h-6" strokeWidth={1.8} />}
      />
      <Tabs
        items={[
          { href: `/customers/${id}`, label: "Overview" },
          { href: `/customers/${id}/invoices`, label: "Invoices" },
          { href: `/customers/${id}/work-orders`, label: "Work Orders" },
          { href: `/customers/${id}/payment-methods`, label: "Payment Methods" },
          { href: `/customers/${id}/billing`, label: "Billing Preferences" },
          { href: `/customers/${id}/notes`, label: "Notes" },
        ]}
      />
      <div className="px-7 py-6">
        <Card>
          <CardBody className="text-ink-dim text-sm">
            Wire up: load customer entity via{" "}
            <code className="text-cyan font-mono">getCustomer({id})</code> from{" "}
            <code className="text-cyan font-mono">lib/entities/customer/queries.ts</code>
          </CardBody>
        </Card>
      </div>
    </>
  )
}
