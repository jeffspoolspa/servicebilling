import { StubPage } from "@/components/shell/stub-page"

export default function PastDuePage() {
  return (
    <StubPage
      crumbs={[{ label: "Service Billing", href: "/service-billing" }, { label: "Past Due" }]}
      eyebrow="Service Billing"
      title="Past Due"
      wireUp={<>Wire up: <code className="text-cyan font-mono">billing.invoices</code> where balance &gt; 0 and due_date &lt; now().</>}
    />
  )
}
