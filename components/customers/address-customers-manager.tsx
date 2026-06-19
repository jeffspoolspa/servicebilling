"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { setAddressActive, unlinkAddress } from "@/app/(shell)/customers/address-actions"
import type { AddressCustomer } from "@/lib/queries/dashboard"

/**
 * Manage the customers linked to an address (ADR 005): mark the active owner (demotes the
 * others), deactivate, or unlink. The active owner should be the currently-serviced customer.
 */
export function AddressCustomersManager({
  locationId,
  customers,
}: {
  locationId: number
  customers: AddressCustomer[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<number | null>(null)

  async function run(cid: number, fn: () => Promise<unknown>) {
    setBusy(cid)
    await fn()
    setBusy(null)
    router.refresh()
  }

  if (!customers.length) {
    return <div className="text-sm text-ink-mute">No customers linked to this address.</div>
  }

  return (
    <ul className="divide-y divide-line-soft text-sm">
      {customers.map((c) => (
        <li key={c.customer_id} className="flex items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <Link href={`/customers/${c.customer_id}` as never} className="text-cyan hover:underline">
              {c.name}
            </Link>
            {c.type && <span className="ml-2 text-[11px] text-ink-mute">{c.type}</span>}
            {c.serviced && (
              <span className="ml-2 rounded bg-coral/15 px-1.5 text-[10px] font-semibold text-coral">
                serviced
              </span>
            )}
          </div>
          {c.is_active ? (
            <>
              <span className="rounded-full bg-grass/15 px-2.5 py-0.5 text-[11px] font-semibold text-grass">
                active owner
              </span>
              <button
                disabled={busy === c.customer_id}
                onClick={() => run(c.customer_id, () => setAddressActive(c.customer_id, locationId, false))}
                className="text-[11px] text-ink-mute hover:text-sun disabled:opacity-50"
              >
                deactivate
              </button>
            </>
          ) : (
            <button
              disabled={busy === c.customer_id}
              onClick={() => run(c.customer_id, () => setAddressActive(c.customer_id, locationId, true))}
              className="text-[11px] text-ink-mute hover:text-cyan disabled:opacity-50"
            >
              make active
            </button>
          )}
          <button
            disabled={busy === c.customer_id}
            onClick={() => run(c.customer_id, () => unlinkAddress(c.customer_id, locationId))}
            className="text-[11px] text-ink-mute hover:text-coral disabled:opacity-50"
          >
            unlink
          </button>
        </li>
      ))}
    </ul>
  )
}
