import { StatusStepper, type Stage } from "@/components/ui/status-stepper"

// Temporary visual-check page. Safe to delete once wired into /leads.
export const dynamic = "force-dynamic"

const LEAD_STAGES: Stage[] = [
  { key: "new", label: "New" },
  { key: "quoted", label: "Quoted" },
  { key: "accepted", label: "Accepted" },
  { key: "converted", label: "Converted" },
]

export default function TimelineDemoPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 p-10">
      {(["new", "quoted", "accepted", "converted", "declined"] as const).map((s) => (
        <div key={s} className="w-full max-w-3xl">
          <div className="text-ink-mute text-xs mb-1.5">current = {s}</div>
          <StatusStepper stages={LEAD_STAGES} current={s} />
        </div>
      ))}
    </div>
  )
}
