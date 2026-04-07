import { StubPage } from "@/components/shell/stub-page"

export default function ActivityPage() {
  return (
    <StubPage
      crumbs={[{ label: "Service Billing", href: "/service-billing" }, { label: "Activity" }]}
      eyebrow="Service Billing"
      title="Activity"
      wireUp={<>Wire up: feed of recent processing attempts, sync runs, status changes.</>}
    />
  )
}
