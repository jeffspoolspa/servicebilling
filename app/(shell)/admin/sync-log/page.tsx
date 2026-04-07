import { StubPage } from "@/components/shell/stub-page"

export default function SyncLogPage() {
  return (
    <StubPage
      crumbs={[{ label: "Admin", href: "/admin" }, { label: "Sync Log" }]}
      eyebrow="Admin"
      title="Sync Log"
      wireUp={<>Wire up: <code className="text-cyan font-mono">billing.processing_attempts</code> + Windmill job runs.</>}
    />
  )
}
