/**
 * Effective dating lives in the SHARED KERNEL — maintenance needs it for task
 * terms exactly as billing needs it for catalog prices. Re-exported here so
 * billing's imports keep reading as billing.
 */
export { EffectiveHistory } from "@/lib/domain/shared/effective"
export type { Effective, PriceBook } from "@/lib/domain/shared/effective"
