import { StubPage } from "@/components/shell/stub-page"

export default function NeedsAttentionPage() {
  return (
    <StubPage
      crumbs={[{ label: "Service Billing", href: "/service-billing" }, { label: "Needs Attention" }]}
      eyebrow="Service Billing"
      title="Needs Attention"
      wireUp={<>Wire up: <code className="text-cyan font-mono">work_orders</code> where billing_status = needs_review.</>}
    />
  )
}
