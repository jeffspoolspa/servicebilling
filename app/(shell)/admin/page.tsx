import { StubPage } from "@/components/shell/stub-page"

export default function AdminPage() {
  return (
    <StubPage
      crumbs={[{ label: "Admin" }]}
      eyebrow="Admin"
      title="Admin Tools"
      sub="Operational tools for app administrators"
      wireUp={<>Sync logs, classification rules, ION mapping, role assignments.</>}
    />
  )
}
