import { StubPage } from "@/components/shell/stub-page"

export default function PaymentMethodsPage() {
  return (
    <StubPage
      crumbs={[{ label: "Service Billing", href: "/service-billing" }, { label: "Payment Methods" }]}
      eyebrow="Service Billing"
      title="Payment Methods"
      sub="All cards and ACH accounts on file in QBO"
      wireUp={<>Wire up: <code className="text-cyan font-mono">billing.customer_payment_methods</code> populated from QBO customer wallet.</>}
    />
  )
}
