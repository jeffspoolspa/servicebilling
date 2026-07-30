"use client"

import { useState, useTransition } from "react"
import { Check, RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { useCanWrite } from "@/components/providers/access-provider"

/**
 * Compact bonus-pool control for the Summary card — replaces the standalone
 * BonusCard. One row: label + a clickable Included/Excluded pill (writers
 * toggle by clicking it), plus a reset affordance when an override diverges
 * from the computed default.
 *
 * State model (work_orders.included_in_bonus):
 *   override null  -> follow default (true iff qbo_class = 'Service')
 *   override bool  -> explicit
 */
export function BonusInline({
  woNumber,
  initialOverride,
  qboClass,
}: {
  woNumber: string
  initialOverride: boolean | null
  qboClass: string | null
}) {
  const canWrite = useCanWrite("service")
  const [override, setOverride] = useState<boolean | null>(initialOverride)
  const [pending, startTransition] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  const defaultIncluded = qboClass === "Service"
  const effective = override === null ? defaultIncluded : override
  const showReset =
    canWrite && override !== null && override !== defaultIncluded

  function post(next: boolean | null) {
    if (pending || !canWrite) return
    const prev = override
    setOverride(next)
    setErr(null)
    startTransition(async () => {
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
        setOverride(prev)
        setErr(e instanceof Error ? e.message : "update failed")
      }
    })
  }

  return (
    <div className="flex justify-between items-center">
      <span className="text-ink-mute">
        Bonus pool
        {override !== null && (
          <span
            className="ml-1.5 text-[9px] uppercase tracking-[0.12em] text-sun"
            title={`Explicit override (default: ${defaultIncluded ? "included" : "excluded"}, class ${qboClass ?? "unknown"})`}
          >
            override
          </span>
        )}
      </span>
      <span className="inline-flex items-center gap-1">
        {showReset && (
          <button
            onClick={() => post(null)}
            disabled={pending}
            className="text-ink-mute hover:text-ink-dim"
            title="Reset to default (follow invoice class)"
          >
            <RotateCcw className="w-3 h-3" strokeWidth={2} />
          </button>
        )}
        <button
          onClick={() => post(!effective)}
          disabled={pending || !canWrite}
          title={
            err ??
            (canWrite
              ? `Click to ${effective ? "exclude from" : "include in"} the bonus pool (default: ${defaultIncluded ? "included" : "excluded"})`
              : `Default: ${defaultIncluded ? "included" : "excluded"} (class ${qboClass ?? "unknown"})`)
          }
          className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border transition-colors",
            effective
              ? "border-cyan/40 bg-cyan/10 text-cyan"
              : "border-line-soft text-ink-mute",
            canWrite && "hover:border-cyan/70 cursor-pointer",
            pending && "opacity-60",
            err && "border-coral/50 text-coral",
          )}
        >
          {effective && <Check className="w-3 h-3" strokeWidth={2.5} />}
          {err ? "retry" : effective ? "Included" : "Excluded"}
        </button>
      </span>
    </div>
  )
}
