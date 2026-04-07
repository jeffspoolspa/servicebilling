import { StubPage } from "@/components/shell/stub-page"

export default async function CustomerPaymentMethodsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <StubPage
      crumbs={[{ label: "Customers", href: "/customers" }, { label: id, href: `/customers/${id}` as never }, { label: "Payment Methods" }]}
      eyebrow="Customer · Tab"
      title="Payment Methods"
      wireUp={<>Wire up: <code className="text-cyan font-mono">billing.customer_payment_methods where customer_id = {id}</code></>}
    />
  )
}
