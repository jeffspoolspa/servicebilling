import { Wrench } from "lucide-react"

export const metadata = { title: "Maintenance" }

/**
 * Placeholder for the Maintenance department. The service-billing
 * architecture will extend here once we start wiring up maintenance ops
 * (scheduled work, chem checks, equipment maintenance).
 */
export default function MaintenancePage() {
  return (
    <div className="flex-1 grid place-items-center px-7 py-16">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="w-12 h-12 rounded-full bg-sun/10 border border-sun/20 grid place-items-center">
          <Wrench className="w-5 h-5 text-sun" strokeWidth={1.8} />
        </div>
        <div className="text-ink font-medium">Maintenance</div>
        <div className="text-ink-mute text-[12px] max-w-sm">
          Maintenance ops coming soon — scheduled work, chem checks,
          equipment tracking.
        </div>
      </div>
    </div>
  )
}
