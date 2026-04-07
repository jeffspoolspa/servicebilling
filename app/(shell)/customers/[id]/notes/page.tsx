import { StubPage } from "@/components/shell/stub-page"

export default async function CustomerNotesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <StubPage
      crumbs={[{ label: "Customers", href: "/customers" }, { label: id, href: `/customers/${id}` as never }, { label: "Notes" }]}
      eyebrow="Customer · Tab"
      title="Notes"
      wireUp={<>Wire up: customer notes table (TBD).</>}
    />
  )
}
