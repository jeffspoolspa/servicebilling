"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

/**
 * Tri-state billable override on a WO.
 *
 * - null      → auto (derive from ION's schedule_status)
 * - true      → force billable=true
 * - false     → force billable=false
 *
 * Useful when ION's schedule_status disagrees with reality (e.g. office flips
 * a WO to non-billable in ION but the schedule_status field doesn't reflect it).
 */
interface BillableOverrideToggleProps {
  woNumber: string
  /** Current override value; null means "auto" */
  override: boolean | null
  /** Currently-effective billable (after override or derivation) */
  effective: boolean
}

export function BillableOverrideToggle({
  woNumber,
  override,
  effective,
}: BillableOverrideToggleProps) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  async function setOverride(value: boolean | null) {
    setLoading(true); setErr(null)
    try {
      const init: RequestInit =
        value === null
          ? { method: "DELETE" }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ override: value }),
            }
      const resp = await fetch(`/api/work-orders/${woNumber}/billable-override`, init)
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      startTransition(() => router.refresh())
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error")
    } finally {
      setLoading(false)
    }
  }

  const overrideLabel =
    override === true ? "forced billable" : override === false ? "forced non-billable" : "auto"

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-ink-mute text-[11px]">Billable</span>
        <span className={effective ? "text-grass text-xs" : "text-ink-mute text-xs"}>
          {effective ? "yes" : "no"}
        </span>
      </div>
      <div className="flex items-center gap-1 text-[11px]">
        <button
          type="button"
          disabled={loading || override === null}
          onClick={() => setOverride(null)}
          className={
            "px-2 py-0.5 rounded border transition-colors disabled:opacity-50 " +
            (override === null
              ? "border-cyan/50 text-cyan bg-cyan/10"
              : "border-line text-ink-dim hover:border-cyan hover:text-cyan")
          }
        >
          Auto
        </button>
        <button
          type="button"
          disabled={loading || override === true}
          onClick={() => setOverride(true)}
          className={
            "px-2 py-0.5 rounded border transition-colors disabled:opacity-50 " +
            (override === true
              ? "border-grass/50 text-grass bg-grass/10"
              : "border-line text-ink-dim hover:border-grass hover:text-grass")
          }
        >
          Force yes
        </button>
        <button
          type="button"
          disabled={loading || override === false}
          onClick={() => setOverride(false)}
          className={
            "px-2 py-0.5 rounded border transition-colors disabled:opacity-50 " +
            (override === false
              ? "border-coral/50 text-coral bg-coral/10"
              : "border-line text-ink-dim hover:border-coral hover:text-coral")
          }
        >
          Force no
        </button>
      </div>
      {override !== null && (
        <div className="text-[10px] text-ink-mute italic">
          Override active: {overrideLabel}. Click Auto to clear.
        </div>
      )}
      {err && <div className="text-[10px] text-coral">{err}</div>}
    </div>
  )
}
