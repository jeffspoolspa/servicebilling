import { AggregateRoot } from "@/lib/domain/kernel"
import { Instrument, type InstrumentState, STRIKE_LIMIT } from "./instrument"

/**
 * The customer's wallet — every vaulted method they have, dead ones
 * included, because the corpses are load-bearing: applySnapshot needs the
 * human-deactivated row present to refuse resurrecting it, and recordDecline
 * has to hold the thing it is disabling. Filtering happens at SELECTION
 * (defaultInstrument / instrumentOfKind), never at loading.
 *
 * The wallet answers "who pays with WHAT". It never charges — the Charge
 * aggregate moves money — and it knows nothing about billing programs
 * (AutopayEnrollment designates one of these instruments BY ID, from the
 * billing context).
 *
 * Replaces (kill list, slice 1): billing.fn_maintain_default_pm — default-
 * ness is now the derived newest-active answer, so there is no stored flag
 * to maintain and no payment_method_default_changed event to emit;
 * customer_payment_methods.is_default survives only as a read projection
 * until the legacy path dies.
 */

/** What a QBO vault refresh reports, in the domain's words (the repository
 *  maps the driver's DTO to this and PRE-MINTS ids for unseen methods —
 *  identity assignment is not a decision, so it stays out of the domain). */
export interface VaultMethod {
  id: string
  onFileId: string
  kind: "card" | "ach"
  brand: string | null
  lastFour: string
  qboCreatedAt: string | null
}

export class Wallet extends AggregateRoot<string> {
  constructor(
    qboCustomerId: string,
    private readonly instruments: Instrument[],
  ) {
    super(qboCustomerId)
  }

  /** Full roster, dead ones included — read surfaces and tests. */
  all(): readonly Instrument[] {
    return this.instruments
  }

  instrument(id: string): Instrument | null {
    return this.instruments.find((i) => i.id === id) ?? null
  }

  /** The newest active method — the auto-charge answer when nobody decided.
   *  (Discovering a card is what opts a customer in; an explicit 'email'
   *  preference is what opts them out — the route policy's rung 4.) */
  defaultInstrument(): Instrument | null {
    return this.actives().sort(byNewestVaulted)[0] ?? null
  }

  /** Human off-switch. Outranks QBO and the strike rule, forever. Idempotent. */
  deactivate(id: string, by: string, at: string): void {
    const inst = this.mustFind(id)
    if (inst.humanDeactivated) return
    inst.markDeactivated(by, at)
    this.record({
      type: "instrument_deactivated",
      payload: { instrument_id: inst.id, on_file_id: inst.onFileId, label: inst.label, by },
      participants: [`pm:${inst.id}`],
      at,
    })
  }

  /** React to a decline THAT IS ALREADY IN THE LEDGER (the handler loads the
   *  wallet after the charge fact commits, so hydration has counted it —
   *  this method evaluates, it does not increment). Emit-once across replays
   *  via the autoDisabledAt stamp readback. */
  recordDecline(id: string, at: string): void {
    const inst = this.mustFind(id)
    if (inst.humanDeactivated || !inst.qboActive) return // already off for a stronger reason
    if (inst.consecutiveDeclines < STRIKE_LIMIT || inst.autoDisabledAt) return
    inst.markAutoDisabled(at)
    this.record({
      type: "instrument_disabled",
      payload: {
        instrument_id: inst.id,
        on_file_id: inst.onFileId,
        label: inst.label,
        consecutive_declines: inst.consecutiveDeclines,
        reason: `${STRIKE_LIMIT} consecutive declines`,
      },
      participants: [`pm:${inst.id}`],
      at,
    })
  }

  /** Converge to what the vault reports. The caller (repository) must NOT
   *  call this on an errored fetch — an errored fetch is not an empty
   *  wallet. Never resurrects a human deactivation: qboActive may flip back
   *  to true, but `active` derivation keeps the instrument off. */
  applySnapshot(methods: VaultMethod[], at: string): void {
    const seen = new Set<string>()
    for (const m of methods) {
      seen.add(m.onFileId)
      const existing = this.instruments.find((i) => i.onFileId === m.onFileId)
      if (existing) {
        existing.converge({ brand: m.brand, lastFour: m.lastFour, qboActive: true })
        continue
      }
      const added = new Instrument({
        ...m,
        qboActive: true,
        humanDeactivated: null,
        consecutiveDeclines: 0,
        autoDisabledAt: null,
      })
      this.instruments.push(added)
      this.record({
        type: "instrument_added",
        payload: { instrument_id: added.id, on_file_id: added.onFileId, label: added.label, kind: added.kind },
        participants: [`pm:${added.id}`],
        at,
      })
    }
    // Dropped from the vault ≠ deleted here: rows survive for charge history;
    // they just stop being chargeable.
    for (const inst of this.instruments) {
      if (seen.has(inst.onFileId) || !inst.qboActive) continue
      inst.converge({ brand: inst.brand, lastFour: inst.lastFour, qboActive: false })
      this.record({
        type: "instrument_dropped",
        payload: { instrument_id: inst.id, on_file_id: inst.onFileId, label: inst.label },
        participants: [`pm:${inst.id}`],
        at,
      })
    }
  }

  private actives(): Instrument[] {
    return this.instruments.filter((i) => i.active)
  }

  private mustFind(id: string): Instrument {
    const inst = this.instrument(id)
    if (!inst) throw new Error(`wallet ${this.id} has no instrument ${id}`)
    return inst
  }
}

const byNewestVaulted = (a: Instrument, b: Instrument): number =>
  (b.qboCreatedAt ?? "").localeCompare(a.qboCreatedAt ?? "")
