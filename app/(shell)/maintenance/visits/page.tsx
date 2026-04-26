import { CalendarCheck } from "lucide-react"
import { EmptyState } from "../_components/empty-state"

export const metadata = { title: "Maintenance · Visits" }

export default function VisitsPage() {
  return (
    <EmptyState
      icon={<CalendarCheck className="w-5 h-5 text-cyan" strokeWidth={1.8} />}
      title="Visits"
      description="Filterable visit table populates once visits ingest from ION (completed) and Skimmer (scheduled)."
    />
  )
}
