import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardBody } from "@/components/ui/card"
import { Users } from "lucide-react"

export default function CustomersPage() {
  return (
    <>
      <Topbar crumbs={[{ label: "Customers" }]} />
      <ObjectHeader
        eyebrow="Entity"
        title="Customers"
        sub="8,785 customers"
        icon={<Users className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6">
        <Card>
          <CardBody className="text-ink-dim text-sm">
            Wire up: list view of <code className="text-cyan font-mono">public.Customers</code>{" "}
            with filters by branch, autopay status, balance.
          </CardBody>
        </Card>
      </div>
    </>
  )
}
