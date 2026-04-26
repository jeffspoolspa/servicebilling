import { Users } from "lucide-react"
import { EmptyState } from "../_components/empty-state"

export const metadata = { title: "Maintenance · Techs" }

/**
 * Tech roster + today's assignments. Reads from public.employees plus
 * derived "today's route" view over maintenance.visits. Stub for now.
 */
export default function TechsPage() {
  return (
    <EmptyState
      icon={<Users className="w-5 h-5 text-cyan" strokeWidth={1.8} />}
      title="Techs"
      description="Tech roster + today's assignments populate once tasks and visits ingest."
    />
  )
}
