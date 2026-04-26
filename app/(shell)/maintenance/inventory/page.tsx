import { Boxes } from "lucide-react"
import { EmptyState } from "../_components/empty-state"

export const metadata = { title: "Maintenance · Inventory" }

/**
 * Ops-side view of inventory: aggregates sign-outs (public.inventory_sign_outs,
 * already live) + truck-check submissions (maintenance.truck_check_submissions,
 * once tech sandbox writes there). Stub for now.
 */
export default function InventoryPage() {
  return (
    <EmptyState
      icon={<Boxes className="w-5 h-5 text-cyan" strokeWidth={1.8} />}
      title="Inventory"
      description="Aggregated sign-outs + truck-check submissions land here once the tech sandbox persists truck checks to maintenance.truck_check_submissions."
    />
  )
}
