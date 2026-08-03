/**
 * Snapshots — how aggregates cross a process boundary (server to browser).
 *
 * The domain is pure TypeScript, so it runs in the browser as readily as on the
 * server: the page loads quotas once, rehydrates them client-side, and every
 * scenario edit after that is local. These functions exist only to get the
 * objects across the wire; they decide nothing.
 */

import { Quota, type Requirement, type Stop } from "./quota"
import { Pin } from "./values"

export interface QuotaSnapshot {
  readonly requirement: Omit<Requirement, "pin"> & { readonly pin: { lat: number; lng: number } | null }
  readonly stops: readonly Stop[]
}

export function toSnapshot(quota: Quota): QuotaSnapshot {
  const { pin, ...rest } = quota.requirement
  return {
    requirement: { ...rest, pin: pin ? { lat: pin.lat, lng: pin.lng } : null },
    stops: quota.stops,
  }
}

export function fromSnapshot(snapshot: QuotaSnapshot): Quota {
  const { pin, ...rest } = snapshot.requirement
  return Quota.rehydrate({ ...rest, pin: pin ? Pin.restore(pin.lat, pin.lng) : null }, snapshot.stops)
}
