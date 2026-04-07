import { StubPage } from "@/components/shell/stub-page"

export default async function CustomerWorkOrdersPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <StubPage
      crumbs={[{ label: "Customers", href: "/customers" }, { label: id, href: `/customers/${id}` as never }, { label: "Work Orders" }]}
      eyebrow="Customer · Tab"
      title="Work Orders"
      wireUp={<>Wire up: <code className="text-cyan font-mono">listWorkOrders({"{ customerId: " + id + " }"})</code></>}
    />
  )
}
