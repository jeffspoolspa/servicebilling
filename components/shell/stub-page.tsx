import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardBody } from "@/components/ui/card"
import { Construction } from "lucide-react"
import { type ReactNode } from "react"

interface StubPageProps {
  crumbs: Array<{ label: string; href?: string }>
  eyebrow?: string
  title: string
  sub?: string
  wireUp: ReactNode
}

export function StubPage({ crumbs, eyebrow, title, sub, wireUp }: StubPageProps) {
  return (
    <>
      <Topbar crumbs={crumbs} />
      <ObjectHeader
        eyebrow={eyebrow}
        title={title}
        sub={sub}
        icon={<Construction className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6">
        <Card>
          <CardBody className="text-ink-dim text-sm">{wireUp}</CardBody>
        </Card>
      </div>
    </>
  )
}
