import { Entity } from "@/lib/domain/kernel"

/**
 * One vaulted payment method, as the wallet knows it. Child entity of the
 * Wallet aggregate — construction and every mutation go THROUGH the root
 * (the @internal methods are the root's levers, not public entry points).
 *
 * `active` is DERIVED, never stored (ADR 011): three independent
 * kill-switches, each with its own authority —
 *   qboActive          the processor still lists it (vault snapshot)
 *   humanDeactivated   a person said off — outranks everything, forever
 *   consecutiveDeclines our own charge ledger's verdict, derived at hydration
 * The resurrection guard IS this derivation: a QBO refresh may flip
 * qboActive back to true (QBO does list it), but humanDeactivated keeps
 * `active` false — Frank Turner (MC x9815, deactivated 2026-06-29, charged
 * 2026-07-27) is why no write path can shortcut this.
 */
export interface InstrumentState {
  /** Storage identity (customer_payment_methods.id) — minted by the caller for new rows. */
  id: string
  /** The PROCESSOR's on-file id — the natural key a charge names. */
  onFileId: string
  kind: "card" | "ach"
  brand: string | null
  lastFour: string
  /** When the processor vaulted it — the "newest active" ordering key. */
  qboCreatedAt: string | null
  qboActive: boolean
  humanDeactivated: { by: string; at: string } | null
  /** Declines since the last success, derived from billing.charges at hydration. */
  consecutiveDeclines: number
  /** Projection stamp readback — makes the disable fact emit-once across replays. */
  autoDisabledAt: string | null
}

export const STRIKE_LIMIT = 3

export class Instrument extends Entity<string> {
  onFileId: string
  kind: "card" | "ach"
  brand: string | null
  lastFour: string
  qboCreatedAt: string | null
  qboActive: boolean
  humanDeactivated: { by: string; at: string } | null
  consecutiveDeclines: number
  autoDisabledAt: string | null

  constructor(s: InstrumentState) {
    super(s.id)
    this.onFileId = s.onFileId
    this.kind = s.kind
    this.brand = s.brand
    this.lastFour = s.lastFour
    this.qboCreatedAt = s.qboCreatedAt
    this.qboActive = s.qboActive
    this.humanDeactivated = s.humanDeactivated
    this.consecutiveDeclines = s.consecutiveDeclines
    this.autoDisabledAt = s.autoDisabledAt
  }

  /** How the memo names it: "MC x9977". Never the PAN. */
  get label(): string {
    return `${this.brand ?? (this.kind === "ach" ? "ACH" : "Card")} x${this.lastFour}`
  }

  /** Chargeable right now. Derived — cannot disagree with the facts it reads. */
  get active(): boolean {
    return this.qboActive && this.humanDeactivated === null && this.consecutiveDeclines < STRIKE_LIMIT
  }

  /** @internal — Wallet.deactivate is the door. */
  markDeactivated(by: string, at: string): void {
    this.humanDeactivated = { by, at }
  }

  /** @internal — Wallet.recordDecline is the door. */
  markAutoDisabled(at: string): void {
    this.autoDisabledAt = at
  }

  /** @internal — Wallet.applySnapshot is the door. */
  converge(from: { brand: string | null; lastFour: string; qboActive: boolean }): void {
    this.brand = from.brand
    this.lastFour = from.lastFour
    this.qboActive = from.qboActive
  }
}
