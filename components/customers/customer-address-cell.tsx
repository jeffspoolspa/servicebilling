"use client"

import Link from "next/link"
import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  MapboxAddressAutocomplete,
  type PickedAddress,
} from "@/components/form/mapbox-address-autocomplete"
import {
  checkAddressRegistry,
  linkCustomerToAddress,
  replaceCustomerAddress,
} from "@/app/(shell)/customers/address-actions"
import type { LinkedAddress } from "@/lib/queries/dashboard"

/**
 * Customer ↔ service-address cell (ADR 005). Shows the active address(es) as clickable pills
 * → the address entity page, with Edit (replace: link new + unlink old) and + add another.
 * When none, offers the Google-autocomplete dropdown. Every link/replace confirms first and
 * warns if the picked address is already someone's active address.
 */
export function CustomerAddressCell({
  customerId,
  addresses,
  manage = false,
}: {
  customerId: number
  addresses: LinkedAddress[]
  /** Show Edit / + add another (detail view). Off in the table — read-only pills, add when empty. */
  manage?: boolean
}) {
  const router = useRouter()
  const [mode, setMode] = useState<"idle" | "add" | "edit">("idle")
  const [picked, setPicked] = useState<PickedAddress | null>(null)
  const [warn, setWarn] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const editingOld = addresses[0] ?? null

  function reset() {
    setMode("idle")
    setPicked(null)
    setWarn(null)
    setErr(null)
  }

  async function onPicked(a: PickedAddress) {
    setPicked(a)
    setErr(null)
    const res = await checkAddressRegistry(a.id)
    const owners = ("activeOwners" in res ? res.activeOwners : undefined) ?? []
    setWarn(
      owners.length > 0
        ? `Already ${owners.join(", ")}'s active address — linking will make this customer the active owner.`
        : null,
    )
  }

  async function confirm() {
    if (!picked) return
    setBusy(true)
    setErr(null)
    const res =
      mode === "edit" && editingOld
        ? await replaceCustomerAddress(customerId, editingOld.location_id, picked)
        : await linkCustomerToAddress(customerId, picked)
    setBusy(false)
    if (res.ok) {
      reset()
      router.refresh()
    } else {
      setErr(res.error ?? "failed")
    }
  }

  // Has address(es), not editing → pills + actions.
  if (mode === "idle" && addresses.length > 0) {
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {addresses.map((a) => (
            <Link
              key={a.location_id}
              href={`/addresses/${a.location_id}` as never}
              className="inline-flex items-center rounded-full border border-line-soft bg-white/[0.03] px-2.5 py-0.5 text-xs text-cyan hover:bg-white/[0.06] hover:underline"
            >
              {[a.street, a.city].filter(Boolean).join(", ") || "address"}
            </Link>
          ))}
        </div>
        {manage && (
          <div className="flex gap-3 text-[11px]">
            <button
              onClick={() => setMode("edit")}
              className="text-ink-mute underline decoration-dotted hover:text-cyan"
            >
              Edit
            </button>
            <button
              onClick={() => setMode("add")}
              className="text-ink-mute underline decoration-dotted hover:text-cyan"
            >
              + add another
            </button>
          </div>
        )}
      </div>
    )
  }

  // No address, not adding → add button.
  if (mode === "idle") {
    return (
      <button
        onClick={() => setMode("add")}
        className="text-xs text-ink-mute underline decoration-dotted hover:text-cyan"
      >
        + Add service address
      </button>
    )
  }

  // Add / edit flow → dropdown + confirm.
  return (
    <div className="min-w-[260px] space-y-2">
      {mode === "edit" && editingOld && (
        <div className="text-[11px] text-ink-mute">
          Replacing: {[editingOld.street, editingOld.city].filter(Boolean).join(", ") || "current address"}
        </div>
      )}
      {!picked ? (
        <MapboxAddressAutocomplete
          onPicked={onPicked}
          autoFocus
          className="w-full rounded-md border border-line bg-bg-elev px-2.5 py-1.5 text-[13px] text-ink outline-none"
          placeholder="Type an address…"
        />
      ) : (
        <div className="space-y-2 rounded-md border border-line bg-bg-elev p-3 text-[13px]">
          <div className="text-ink">{picked.label}</div>
          {mode === "edit" && (
            <div className="text-[12px] text-ink-mute">
              Unlinks the old address and links this one.
            </div>
          )}
          {warn && <div className="text-[12px] text-sun">{warn}</div>}
          {err && <div className="text-[12px] text-coral">{err}</div>}
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={confirm}
              className="rounded-md bg-cyan/15 px-3 py-1 text-xs text-cyan hover:bg-cyan/25 disabled:opacity-50"
            >
              {busy ? "Saving…" : mode === "edit" ? "Confirm change" : "Confirm link"}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setPicked(null)
                setWarn(null)
              }}
              className="rounded-md px-3 py-1 text-xs text-ink-mute hover:text-ink"
            >
              Back
            </button>
          </div>
        </div>
      )}
      <button onClick={reset} className="text-[11px] text-ink-mute hover:text-ink">
        cancel
      </button>
    </div>
  )
}
