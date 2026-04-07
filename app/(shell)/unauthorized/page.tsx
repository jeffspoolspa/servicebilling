import { StubPage } from "@/components/shell/stub-page"

export default function UnauthorizedPage() {
  return (
    <StubPage
      crumbs={[{ label: "Unauthorized" }]}
      eyebrow="Access denied"
      title="You don't have access to this page"
      sub="Ask Carter to add your role in app_roles"
      wireUp={<>If this is wrong, sign out and back in to refresh your roles.</>}
    />
  )
}
