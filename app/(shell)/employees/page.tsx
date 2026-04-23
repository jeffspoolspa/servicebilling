import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardBody } from "@/components/ui/card"
import { HardHat } from "lucide-react"

export default function EmployeesPage() {
  return (
    <>
      <ObjectHeader
        eyebrow="Entity"
        title="Employees"
        sub="96 employees · synced from Gusto"
        icon={<HardHat className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6">
        <Card>
          <CardBody className="text-ink-dim text-sm">
            Wire up: list view of <code className="text-cyan font-mono">public.employees</code>{" "}
            with ION mapping status.
          </CardBody>
        </Card>
      </div>
    </>
  )
}
