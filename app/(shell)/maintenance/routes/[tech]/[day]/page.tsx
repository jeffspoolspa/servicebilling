import { Map } from "lucide-react"
import { EmptyState } from "../../../_components/empty-state"

export const metadata = { title: "Maintenance · Route" }

/**
 * One specific route's stops — the active tasks for (tech_employee_id, day_of_week).
 * Stub for now; will list service locations on this tech's day in sequence
 * order once tasks flow in.
 */
export default async function RouteDetailPage({
  params,
}: {
  params: Promise<{ tech: string; day: string }>
}) {
  const { tech, day } = await params
  const dayLabel =
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      Number(day)
    ] ?? day
  return (
    <EmptyState
      icon={<Map className="w-5 h-5 text-cyan" strokeWidth={1.8} />}
      title={`${dayLabel} route`}
      description={`Stops for tech ${tech} on ${dayLabel} populate once active tasks exist.`}
    />
  )
}
