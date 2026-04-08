import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Tabs } from "@/components/shell/tabs"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Users } from "lucide-react"
import { notFound } from "next/navigation"
import { getCustomerById } from "@/lib/queries/dashboard"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function CustomerDetailPage({ params }: PageProps) {
  const { id } = await params
  const customer = await getCustomerById(id)
  if (!customer) notFound()

  return (
    <>
      <Topbar
        crumbs={[
          { label: "Customers", href: "/customers" },
          { label: customer.display_name },
        ]}
      />
      <ObjectHeader
        eyebrow="Customer"
        title={customer.display_name}
        sub={`ID ${customer.id} · QBO ${customer.qbo_customer_id ?? "—"} · ${customer.email ?? "no email"}`}
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
      <div className="px-7 py-6 grid grid-cols-2 gap-5">
        <Card>
          <CardHeader>
            <CardTitle>Contact</CardTitle>
          </CardHeader>
          <CardBody className="text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-ink-mute">Display name</span>
              <span className="text-ink">{customer.display_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-mute">Email</span>
              <span className="text-ink-dim">{customer.email ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-mute">Phone</span>
              <span className="text-ink-dim font-mono">{customer.phone ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-mute">QBO Customer ID</span>
              <span className="text-cyan font-mono">{customer.qbo_customer_id ?? "—"}</span>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Billing summary</CardTitle>
          </CardHeader>
          <CardBody className="text-sm text-ink-dim">
            Wire up: invoices count, open balance, payment methods on file, autopay status.
          </CardBody>
        </Card>
      </div>
    </>
  )
}
