import { StubPage } from "@/components/shell/stub-page"

export default function RevenuePage() {
  return (
    <StubPage
      crumbs={[{ label: "Service Billing", href: "/service-billing" }, { label: "Revenue" }]}
      eyebrow="Service Billing"
      title="Revenue"
      sub="Revenue by employee, branch, service category"
      wireUp={<>Wire up: <code className="text-cyan font-mono">billing.v_revenue_by_employee</code>.</>}
    />
  )
}
