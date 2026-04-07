import { StubPage } from "@/components/shell/stub-page"

export default function IonMappingPage() {
  return (
    <StubPage
      crumbs={[{ label: "Admin", href: "/admin" }, { label: "ION Mapping" }]}
      eyebrow="Admin"
      title="ION Username Mapping"
      sub="Map technician usernames from work_orders.assigned_to to employees"
      wireUp={
        <>
          Wire up: list unmapped technicians from{" "}
          <code className="text-cyan font-mono">v_unmapped_technicians</code>, suggest matches
          based on prefix + first name, write{" "}
          <code className="text-cyan font-mono">setIonUsernames()</code>.
        </>
      }
    />
  )
}
