import { StubPage } from "@/components/shell/stub-page"

export default async function CustomerInvoicesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <StubPage
      crumbs={[{ label: "Customers", href: "/customers" }, { label: id, href: `/customers/${id}` as never }, { label: "Invoices" }]}
      eyebrow="Customer · Tab"
      title="Invoices"
      wireUp={<>Wire up: <code className="text-cyan font-mono">listInvoicesForCustomer({id})</code></>}
    />
  )
}
