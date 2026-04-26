import { notFound } from "next/navigation"
import { CalendarCheck } from "lucide-react"
import { getVisit } from "@/lib/entities/visit"
import { Card, CardBody } from "@/components/ui/card"
import { EmptyState } from "../../_components/empty-state"

export const metadata = { title: "Maintenance · Visit" }

export default async function VisitDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const visit = await getVisit(id)
  if (!visit) {
    // No data yet — show empty state instead of 404 while the table is empty.
    // Once visits ingest, swap to notFound() for unknown ids.
    return (
      <EmptyState
        icon={<CalendarCheck className="w-5 h-5 text-cyan" strokeWidth={1.8} />}
        title="Visit not found"
        description={`No visit with id ${id}. Visits populate once Skimmer / ION ingest is wired.`}
      />
    )
  }
  // When visits exist this branch becomes the real detail layout.
  // For now keep notFound disabled and render a minimal summary card.
  void notFound // suppress unused-import warning while stub is live
  return (
    <div className="px-7 py-6 space-y-4">
      <Card>
        <CardBody>
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">Visit</div>
          <div className="font-display text-[18px] mt-0.5">{visit.visit_date}</div>
          <div className="text-ink-mute text-[12px] mt-1">
            Status {visit.status} · Type {visit.visit_type}
            {visit.is_manually_reassigned ? " · manually reassigned" : ""}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
