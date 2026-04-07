import { StubPage } from "@/components/shell/stub-page"

export default function ClassificationRulesPage() {
  return (
    <StubPage
      crumbs={[{ label: "Admin", href: "/admin" }, { label: "Classification Rules" }]}
      eyebrow="Admin"
      title="Classification Rules"
      wireUp={<>Wire up: CRUD over <code className="text-cyan font-mono">billing.classification_rules</code>.</>}
    />
  )
}
