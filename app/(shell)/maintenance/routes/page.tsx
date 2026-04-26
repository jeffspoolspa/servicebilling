import { Map } from "lucide-react"
import { EmptyState } from "../_components/empty-state"

export const metadata = { title: "Maintenance · Routes" }

/**
 * "Routes" is a derived view — GROUP BY (tech, day_of_week) over
 * maintenance.tasks. No routes table. Once tasks ingest from Skimmer, this
 * page lists each (tech, day) bucket and links to /routes/[tech]/[day].
 */
export default function RoutesPage() {
  return (
    <EmptyState
      icon={<Map className="w-5 h-5 text-cyan" strokeWidth={1.8} />}
      title="Routes"
      description="Routes are derived from active tasks (tech + day). List populates once Skimmer task ingest is wired."
    />
  )
}
