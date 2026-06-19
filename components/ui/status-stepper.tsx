import { cn } from "@/lib/utils/cn"

/**
 * Read-only chevron stepper showing where an entity sits in its lifecycle. The
 * stage is DERIVED — this only displays it; it never changes status. Past + current
 * stages read as filled (current strongest), future stages muted. If `current` is a
 * terminal off-ramp not in `stages` (declined/expired/disqualified), it renders a
 * single coral terminal chevron instead of the progression.
 *
 * Reusable: any entity passes its own ordered `stages` + the current key.
 */

export interface Stage {
  key: string
  label: string
}

const chevronClip = {
  first: "polygon(0 0, calc(100% - 11px) 0, 100% 50%, calc(100% - 11px) 100%, 0 100%)",
  middle: "polygon(0 0, calc(100% - 11px) 0, 100% 50%, calc(100% - 11px) 100%, 0 100%, 11px 50%)",
  last: "polygon(0 0, 100% 0, 100% 100%, 0 100%, 11px 50%)",
  only: "polygon(0 0, 100% 0, 100% 100%, 0 100%)",
} as const

function clipFor(i: number, n: number): string {
  if (n === 1) return chevronClip.only
  if (i === 0) return chevronClip.first
  if (i === n - 1) return chevronClip.last
  return chevronClip.middle
}

interface StatusStepperProps {
  stages: Stage[]
  /** Current stage key. If not found in `stages`, treated as a terminal off-ramp. */
  current: string
  className?: string
}

export function StatusStepper({ stages, current, className }: StatusStepperProps) {
  const currentIndex = stages.findIndex((s) => s.key === current)
  const terminal = currentIndex === -1

  if (terminal) {
    return (
      <div className={cn("flex", className)}>
        <div
          className="flex items-center justify-center px-5 h-9 text-[13px] font-semibold bg-coral/20 text-coral"
          style={{ clipPath: chevronClip.only }}
        >
          {current.charAt(0).toUpperCase() + current.slice(1)}
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex gap-1", className)}>
      {stages.map((stage, i) => {
        const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "todo"
        return (
          <div
            key={stage.key}
            className={cn(
              "flex-1 flex items-center justify-center h-9 px-4 text-[13px] whitespace-nowrap",
              state === "current" && "bg-cyan text-bg font-semibold",
              state === "done" && "bg-cyan/20 text-cyan font-medium",
              state === "todo" && "bg-white/[0.03] text-ink-mute",
            )}
            style={{ clipPath: clipFor(i, stages.length) }}
          >
            {stage.label}
          </div>
        )
      })}
    </div>
  )
}
