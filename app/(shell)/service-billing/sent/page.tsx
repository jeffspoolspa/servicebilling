import { StubPage } from "@/components/shell/stub-page"

export default function SentPage() {
  return (
    <StubPage
      crumbs={[{ label: "Service Billing", href: "/service-billing" }, { label: "Sent" }]}
      eyebrow="Service Billing"
      title="Sent Invoices"
      wireUp={<>Wire up: <code className="text-cyan font-mono">billing.invoices</code> where synced_at is not null.</>}
    />
  )
}
