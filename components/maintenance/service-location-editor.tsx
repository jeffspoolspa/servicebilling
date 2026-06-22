"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  MapboxAddressAutocomplete,
  type PickedAddress,
} from "@/components/form/mapbox-address-autocomplete"
import {
  editServiceLocationAddress,
  mergeServiceLocationIntoExisting,
  retireServiceLocation,
} from "@/app/(shell)/maintenance/customers/address-edit-actions"

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
  const [mode, setMode] = useState<"idle" | "edit" | "remove">("idle")
  const [picked, setPicked] = useState<PickedAddress | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // When the picked address already exists as another canonical location, we offer to
  // merge this (duplicate) location onto it instead of erroring (the O'BRIEN case).
  const [dup, setDup] = useState<{ into: number; label: string } | null>(null)

  function reset() {
    setMode("idle")
    setPicked(null)
    setErr(null)
    setDup(null)
  }

  async function confirm() {
    if (!picked) return
    setBusy(true)
    setErr(null)
    setDup(null)
    const res = await editServiceLocationAddress(locationId, customerId, picked)
    setBusy(false)
    if (res.ok) {
      reset()
      router.refresh()
    } else if (res.duplicateOf) {
      setDup({ into: res.duplicateOf, label: res.duplicateLabel ?? `#${res.duplicateOf}` })
    } else {
      setErr(res.error)
    }
  }

  async function merge() {
    if (!dup) return
    setBusy(true)
    setErr(null)
    const res = await mergeServiceLocationIntoExisting(locationId, dup.into, customerId)
    setBusy(false)
    if (res.ok) {
      reset()
      router.refresh()
    } else {
      setErr(res.error)
    }
  }

  async function remove() {
    setBusy(true)
    setErr(null)
    const res = await retireServiceLocation(locationId, customerId)
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
      <span className="inline-flex items-center gap-2.5">
        <button
          onClick={() => setMode("edit")}
          className="text-[11px] text-ink-mute underline decoration-dotted hover:text-cyan"
        >
          Edit
        </button>
        <button
          onClick={() => setMode("remove")}
          className="text-[11px] text-ink-mute underline decoration-dotted hover:text-coral"
        >
          Remove
        </button>
      </span>
    )
  }

  if (mode === "remove") {
    return (
      <div className="min-w-[220px] space-y-2 py-1">
        <div className="text-[12px] text-ink">
          Remove <span className="text-ink-mute">{current || "this location"}</span> from this customer?
        </div>
        <div className="text-[11px] text-ink-mute">
          Drops the link and retires the row. Refused if any task or visit still points here (merge those first).
        </div>
        {err && <div className="text-[12px] text-coral">{err}</div>}
        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={remove}
            className="rounded-md bg-coral/15 px-3 py-1 text-xs text-coral hover:bg-coral/25 disabled:opacity-50"
          >
            {busy ? "Removing…" : "Remove"}
          </button>
          <button
            disabled={busy}
            onClick={reset}
            className="rounded-md px-3 py-1 text-xs text-ink-mute hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </div>
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
      ) : dup ? (
        <div className="space-y-2 rounded-md border border-sun/40 bg-sun/5 p-3 text-[13px]">
          <div className="text-ink">{picked.label}</div>
          <div className="text-[12px] text-ink-mute">
            Already on file as <span className="text-ink">{dup.label}</span>. This is a duplicate of
            that location — move this customer&apos;s tasks, visits, and history onto it and retire
            this row.
          </div>
          {err && <div className="text-[12px] text-coral">{err}</div>}
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={merge}
              className="rounded-md bg-sun/20 px-3 py-1 text-xs text-sun hover:bg-sun/30 disabled:opacity-50"
            >
              {busy ? "Merging…" : "Merge & repoint"}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setPicked(null)
                setDup(null)
                setErr(null)
              }}
              className="rounded-md px-3 py-1 text-xs text-ink-mute hover:text-ink"
            >
              Back
            </button>
          </div>
        </div>
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
