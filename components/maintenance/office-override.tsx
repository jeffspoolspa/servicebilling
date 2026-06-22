"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Pill } from "@/components/ui/pill"
import {
  setCustomerOffice,
  clearCustomerOfficeOverride,
} from "@/app/(shell)/maintenance/customers/office-actions"

/**
 * Customer office control (ADR 007 §9). Shows the office of record — geography-derived from the
 * service address (nearest branch), or a manual override — and lets staff change it. Picking a
 * branch sets a sticky override; "use geographic" releases it back to the auto-derived office.
 * (This is the CUSTOMER's office, for customer queries/filtering; a route's office is the tech's.)
 */
export function OfficeOverride({
  customerId,
  officeId,
  officeName,
  overridden,
  distanceMi,
  branches,
}: {
  customerId: number
  officeId: string | null
  officeName: string | null
  overridden: boolean
  distanceMi: number | null
  branches: Array<{ id: string; name: string }>
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function pick(id: string) {
    if (id === officeId && overridden) {
      setEditing(false)
      return
    }
    setBusy(true)
    setErr(null)
    const res = await setCustomerOffice(customerId, id)
    setBusy(false)
    if (res.ok) {
      setEditing(false)
      router.refresh()
    } else setErr(res.error)
  }

  async function useGeographic() {
    setBusy(true)
    setErr(null)
    const res = await clearCustomerOfficeOverride(customerId)
    setBusy(false)
    if (res.ok) {
      setEditing(false)
      router.refresh()
    } else setErr(res.error)
  }

  const shortName = (officeName ?? "").split(",")[0]

  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-ink-mute">Office:</span>
      <span className="text-ink">{shortName || "—"}</span>
      {overridden ? (
        <Pill tone="sun">manual</Pill>
      ) : distanceMi != null ? (
        <span className="text-[11px] text-ink-mute">geographic · {Math.round(distanceMi)} mi</span>
      ) : officeId == null ? (
        <span className="text-[11px] text-coral">unresolved</span>
      ) : null}

      {!editing ? (
        <button
          onClick={() => setEditing(true)}
          className="text-[11px] text-ink-mute underline decoration-dotted hover:text-cyan"
        >
          change
        </button>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <select
            disabled={busy}
            defaultValue={overridden && officeId ? officeId : ""}
            onChange={(e) => e.target.value && pick(e.target.value)}
            className="rounded-md border border-line bg-bg-elev px-2 py-0.5 text-[12px] text-ink outline-none"
          >
            <option value="" disabled>
              Set office…
            </option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name.split(",")[0]}
              </option>
            ))}
          </select>
          {overridden && (
            <button
              disabled={busy}
              onClick={useGeographic}
              className="text-[11px] text-ink-mute underline decoration-dotted hover:text-cyan"
            >
              use geographic
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => {
              setEditing(false)
              setErr(null)
            }}
            className="text-[11px] text-ink-mute hover:text-ink"
          >
            cancel
          </button>
        </span>
      )}
      {err && <span className="text-[11px] text-coral">{err}</span>}
    </span>
  )
}
