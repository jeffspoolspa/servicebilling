import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardBody } from "@/components/ui/card"
import { FileText } from "lucide-react"

export default function InvoicesPage() {
  return (
    <>
      <ObjectHeader
        eyebrow="Entity"
        title="Invoices"
        icon={<FileText className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6">
        <Card>
          <CardBody className="text-ink-dim text-sm">
            Wire up: list view of <code className="text-cyan font-mono">billing.invoices</code>.
            Module-owned schema, top-level URL.
          </CardBody>
        </Card>
      </div>
    </>
  )
}
