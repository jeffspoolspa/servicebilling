import { StubPage } from "@/components/shell/stub-page"

export default async function CustomerBillingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <StubPage
      crumbs={[{ label: "Customers", href: "/customers" }, { label: id, href: `/customers/${id}` as never }, { label: "Billing Preferences" }]}
      eyebrow="Customer · Tab"
      title="Billing Preferences"
      wireUp={<>Wire up: <code className="text-cyan font-mono">billing.customer_billing_preferences</code></>}
    />
  )
}
