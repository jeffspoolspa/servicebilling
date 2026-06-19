"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  MapboxAddressAutocomplete,
  type PickedAddress,
} from "@/components/form/mapbox-address-autocomplete"
import { editServiceLocationAddress } from "@/app/(shell)/maintenance/customers/address-edit-actions"

/**
 * Edit a service_location's address IN PLACE via the Google autocomplete (ADR 007). For
 * correcting a wrong service address — the row's tasks/visits/route position all update,
 * since the task points at this same location. (Replacing/relinking is a different operation
 * on the top-level customer page.)
 */
export function ServiceLocationEditor({
  locationId,
  customerId,
  current,
}: {
  locationId: number
  customerId: number
  current: string
}) {
  const router = useRouter()
  const [mode, setMode] = useState<"idle" | "edit">("idle")
  const [picked, setPicked] = useState<PickedAddress | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function reset() {
    setMode("idle")
    setPicked(null)
    setErr(null)
  }

  async function confirm() {
    if (!picked) return
    setBusy(true)
    setErr(null)
    const res = await editServiceLocationAddress(locationId, customerId, picked)
    setBusy(false)
    if (res.ok) {
      reset()
      router.refresh()
    } else {
      setErr(res.error)
    }
  }

  if (mode === "idle") {
    return (
      <button
        onClick={() => setMode("edit")}
        className="text-[11px] text-ink-mute underline decoration-dotted hover:text-cyan"
      >
        Edit
      </button>
    )
  }

  return (
    <div className="min-w-[260px] space-y-2 py-1">
      <div className="text-[11px] text-ink-mute">Correcting: {current || "this address"}</div>
      {!picked ? (
        <MapboxAddressAutocomplete
          onPicked={setPicked}
          autoFocus
          className="w-full rounded-md border border-line bg-bg-elev px-2.5 py-1.5 text-[13px] text-ink outline-none"
          placeholder="Type the correct address…"
        />
      ) : (
        <div className="space-y-2 rounded-md border border-line bg-bg-elev p-3 text-[13px]">
          <div className="text-ink">{picked.label}</div>
          <div className="text-[12px] text-ink-mute">
            Updates this location in place — its route position, visits, and tasks all follow.
          </div>
          {err && <div className="text-[12px] text-coral">{err}</div>}
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={confirm}
              className="rounded-md bg-cyan/15 px-3 py-1 text-xs text-cyan hover:bg-cyan/25 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Confirm correction"}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setPicked(null)
                setErr(null)
              }}
              className="rounded-md px-3 py-1 text-xs text-ink-mute hover:text-ink"
            >
              Back
            </button>
          </div>
        </div>
      )}
      <button onClick={reset} className="block text-[11px] text-ink-mute hover:text-ink">
        cancel
      </button>
    </div>
  )
}
