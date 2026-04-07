import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardBody } from "@/components/ui/card"
import { ClipboardList } from "lucide-react"

export default function WorkOrdersPage() {
  return (
    <>
      <Topbar crumbs={[{ label: "Work Orders" }]} />
      <ObjectHeader
        eyebrow="Entity"
        title="Work Orders"
        icon={<ClipboardList className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6">
        <Card>
          <CardBody className="text-ink-dim text-sm">
            Wire up: list view of <code className="text-cyan font-mono">public.work_orders</code>.
          </CardBody>
        </Card>
      </div>
    </>
  )
}
