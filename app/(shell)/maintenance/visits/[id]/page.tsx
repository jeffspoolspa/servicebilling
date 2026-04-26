import Link from "next/link"
import { notFound } from "next/navigation"
import { Card, CardBody } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import { getVisitWithContext } from "../../_lib/views"

export const metadata = { title: "Maintenance · Visit" }
export const dynamic = "force-dynamic"

export default async function VisitDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const visit = await getVisitWithContext(id)
  if (!visit) notFound()

  const reassigned =
    visit.visit_date !== visit.scheduled_date ||
    (visit.actual_tech_id !== null &&
      visit.scheduled_tech_id !== null &&
      visit.actual_tech_id !== visit.scheduled_tech_id)

  return (
    <div className="px-7 py-6 space-y-4">
      <Link href="/maintenance/visits" className="text-[12px] text-ink-mute hover:text-ink">
        ← Visits
      </Link>

      <Card>
        <CardBody>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">
                {visit.visit_type} · {visit.visit_date}
              </div>
              <h2 className="font-display text-[18px] mt-0.5">
                {visit.customer_name ?? "(unknown customer)"}
              </h2>
              <div className="text-ink-dim text-[13px] mt-1">
                {visit.service_location_street ?? "—"}
                {visit.service_location_city && (
                  <span className="text-ink-mute">, {visit.service_location_city}</span>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Pill tone={visit.status === "completed" ? "grass" : visit.status === "scheduled" ? "cyan" : "sun"} dot>
                {visit.status}
              </Pill>
              {reassigned && <Pill tone="sun">manually reassigned</Pill>}
            </div>
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardBody>
            <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">Tech</div>
            <div className="text-ink mt-1">{visit.actual_tech_name ?? "—"}</div>
            {visit.scheduled_tech_name && visit.scheduled_tech_name !== visit.actual_tech_name && (
              <div className="text-ink-mute text-[11px] mt-0.5">
                originally scheduled: {visit.scheduled_tech_name}
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">Price</div>
            <div className="text-ink font-mono num mt-1">
              {visit.price_cents != null ? formatCurrency(visit.price_cents / 100) : "—"}
            </div>
            {visit.snapshot_frequency && (
              <div className="text-ink-mute text-[11px] mt-0.5">{visit.snapshot_frequency} cadence</div>
            )}
          </CardBody>
        </Card>
      </div>

      {visit.notes && (
        <Card>
          <CardBody>
            <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">Notes</div>
            <div className="text-ink-dim text-[12px] mt-1 whitespace-pre-wrap">{visit.notes}</div>
          </CardBody>
        </Card>
      )}
    </div>
  )
}
