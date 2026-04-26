import { LayoutDashboard } from "lucide-react"
import { EmptyState } from "../_components/empty-state"

export const metadata = { title: "Maintenance · Dashboard" }

export default function MaintenanceDashboardPage() {
  return (
    <EmptyState
      icon={<LayoutDashboard className="w-5 h-5 text-cyan" strokeWidth={1.8} />}
      title="Dashboard"
      description="KPIs land here once Skimmer + ION ingest flows are wired: visits today, missed, chem alerts, low-stock truck checks."
    />
  )
}
