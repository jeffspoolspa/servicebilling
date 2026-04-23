"use client"

import { useState, useTransition } from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * Inline bonus-inclusion toggle — tiny checkbox that flips
 * work_orders.included_in_bonus.
 *
 * Visual semantics:
 *   - Filled cyan check = included in the bonus pool
 *   - Empty box         = excluded
 *   - Orange dot in the corner = this value is an explicit user override
 *     (rather than the computed default). Hover reveals the tooltip
 *     explaining the default.
 *
 * Click writes the OPPOSITE explicit value to the DB. There is no
 * "reset to default" in the table UI; that's available in the detail
 * page's Bonus card (future enhancement).
 */
export function BonusToggle({
  woNumber,
  initialIncluded,
  initialOverride,
  qboClass,
  size = "sm",
}: {
  woNumber: string
  initialIncluded: boolean
  initialOverride: boolean | null
  /** The invoice's qbo_class — used only to describe the default in the tooltip. */
  qboClass: string | null
  size?: "sm" | "md"
}) {
  const [included, setIncluded] = useState(initialIncluded)
  const [override, setOverride] = useState(initialOverride)
  const [pending, startTransition] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  function toggle(e: React.MouseEvent) {
    // Prevent the parent row-link from navigating when the user just
    // wanted to toggle the checkbox.
    e.preventDefault()
    e.stopPropagation()
    if (pending) return
    const next = !included
    startTransition(async () => {
      // Optimistic update
      setIncluded(next)
      setOverride(next)
      setErr(null)
      try {
        const resp = await fetch(
          `/api/work-orders/${encodeURIComponent(woNumber)}/bonus`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ included: next }),
          },
        )
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}))
          throw new Error(body?.error ?? `${resp.status}`)
        }
      } catch (e) {
        // Revert optimistic update
        setIncluded(!next)
        setOverride(initialOverride)
        setErr(e instanceof Error ? e.message : "toggle failed")
      }
    })
  }

  const dimension = size === "md" ? "w-5 h-5" : "w-4 h-4"
  const defaultLabel =
    qboClass === "Service" ? "Default: included (Service invoice)" : "Default: excluded"
  const title = err
    ? `Error: ${err}`
    : override !== null
      ? `Override: ${included ? "included" : "excluded"} · ${defaultLabel}`
      : defaultLabel

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      title={title}
      aria-label={included ? "Remove from bonus pool" : "Add to bonus pool"}
      className={cn(
        "relative inline-flex items-center justify-center rounded border transition-colors",
        dimension,
        included
          ? "bg-cyan/15 border-cyan/60 text-cyan hover:bg-cyan/25"
          : "bg-bg-elev border-line text-transparent hover:border-line/80",
        pending && "opacity-60 cursor-wait",
        !pending && "cursor-pointer",
      )}
    >
      {included && (
        <Check className="w-3 h-3" strokeWidth={2.5} />
      )}
      {override !== null && (
        <span
          className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-sun shadow-[0_0_0_1px_rgb(var(--bg-elev))]"
          title="User override"
        />
      )}
    </button>
  )
}
