/**
 * Task — the standing service contract at one place.
 *
 * The heart of maintenance: an active task means an active maintenance
 * customer. Signup creates one, its schedule generates visits, and every month
 * it is active it owes exactly one invoice.
 *
 * SHAPE (verified against the database, 2026-07-31 — note this corrects
 * docs/model/task.html, which says the money lives on the slot):
 *
 *   header  maintenance.tasks          the money + the lifecycle
 *   slots   maintenance.task_schedules one row per serviced weekday
 *
 * The grain is exact: 504 active tasks carry 504 distinct ion_task_ids, and no
 * task's slots span two ION tasks. So ONE ION recurring task == ONE header ==
 * N day slots, which is also the shape of ION's own form: a single price
 * (itemcost) and seven per-day tech selects. A second service at the same place
 * that charges differently cannot be a slot — there is nowhere on one header to
 * put two prices — it is a second task.
 *
 * This aggregate owns every rule about what a valid task IS. It performs no
 * I/O: it decides, records what it decided, and is handed to someone else to
 * persist (see pullEvents + the ports file).
 */

import type { Weekday } from "@/lib/routing/domain"

/** How a task charges. The header carries the money, not the slots. */
export type BillingMethod = "per_visit" | "flat_rate_monthly"

/** How often a slot recurs. A/B pick which of the alternating weeks it takes. */
export type Frequency = "weekly" | "biweekly_a" | "biweekly_b" | "monthly" | "daily"

export class TaskRuleError extends Error {}

/** One serviced weekday: who goes, and how often. */
export interface Slot {
  readonly weekday: Weekday
  readonly techId: string | null
  readonly frequency: Frequency
}

/**
 * The commercial terms. What a human states when opening or changing a
 * contract — nothing derived, nothing observed, nothing minted.
 */
export interface Terms {
  readonly billingMethod: BillingMethod
  /**
   * The negotiated price in cents. Null means "whatever the catalog service
   * type charges" — Carter's rule: itemcost wins when populated, otherwise the
   * ServiceType's own price governs. Null is therefore meaningful, not missing.
   */
  readonly priceCents: number | null
  /** ION's catalog service, which carries the fallback price. */
  readonly serviceTypeId: string
  readonly startsOn: string
  /** null = open-ended, the normal case. */
  readonly endsOn: string | null
  readonly slots: readonly Slot[]
  readonly note?: string
}

/** A fact this task recorded about itself. Drained by whoever persists it. */
export interface TaskEvent {
  readonly type: "TaskOpened" | "TaskTermsChanged" | "TaskClosed"
  readonly taskId: string | null
  readonly at: string
  readonly payload: Record<string, unknown>
}

/** The complete state to write outward — every day, blank where unserved. */
export interface DesiredWeek {
  readonly customerId: number
  /** Null while the task has never been written to ION (a create). */
  readonly ionTaskId: string | null
  readonly serviceTypeId: string
  readonly billingMethod: BillingMethod
  readonly priceCents: number | null
  readonly startsOn: string
  readonly endsOn: string | null
  /** The one cadence the whole task recurs on (see the uniform-frequency rule). */
  readonly frequency: Frequency
  /** weekday -> techId, absent where the task is not serviced. */
  readonly days: ReadonlyMap<Weekday, string | null>
  readonly note: string
}

const isoDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)

export class Task {
  private readonly recorded: TaskEvent[] = []

  private constructor(
    /** Null until persisted — a task being opened has no identity yet. */
    private _id: string | null,
    readonly customerId: number,
    private _ionTaskId: string | null,
    private _terms: Terms,
    private _status: "active" | "paused" | "closed",
  ) {}

  /* ------------------------------------------------------------- creation */

  /**
   * FACTORY. Produces a valid Task or refuses — the one place that says what
   * "a legitimate contract" means. No id and no ionTaskId, because neither
   * exists until something downstream mints them.
   */
  static open(customerId: number, terms: Terms, at = "1970-01-01T00:00:00Z"): Task {
    Task.validate(terms)
    const task = new Task(null, customerId, null, terms, "active")
    task.recorded.push({
      type: "TaskOpened",
      taskId: null,
      at,
      payload: { customerId, terms: { ...terms, slots: [...terms.slots] } },
    })
    return task
  }

  /**
   * RECONSTITUTION. Rebuilds a task that already exists; records nothing and
   * validates nothing, because what is stored was valid when it was stored.
   * Not a factory — this mints no identity.
   */
  static rehydrate(
    id: string,
    customerId: number,
    ionTaskId: string | null,
    terms: Terms,
    status: "active" | "paused" | "closed",
  ): Task {
    return new Task(id, customerId, ionTaskId, terms, status)
  }

  private static validate(terms: Terms): void {
    if (!isoDay(terms.startsOn)) throw new TaskRuleError("startsOn must be YYYY-MM-DD")
    if (terms.endsOn !== null && !isoDay(terms.endsOn)) {
      throw new TaskRuleError("endsOn must be YYYY-MM-DD or null")
    }
    if (terms.endsOn !== null && terms.endsOn < terms.startsOn) {
      throw new TaskRuleError("a contract cannot end before it starts")
    }
    if (!terms.serviceTypeId.trim()) throw new TaskRuleError("a task needs a service type")
    if (terms.priceCents !== null && terms.priceCents < 0) {
      throw new TaskRuleError("price cannot be negative")
    }
    if (terms.slots.length === 0) {
      throw new TaskRuleError("a task with no serviced day would never generate a visit")
    }
    // One visit per weekday: ION holds one tech per day, so two slots on one
    // day is unrepresentable there and would silently lose one.
    const days = new Set<number>()
    for (const s of terms.slots) {
      if (days.has(s.weekday)) {
        throw new TaskRuleError(`two slots on weekday ${s.weekday} — ION holds one tech per day`)
      }
      days.add(s.weekday)
    }
    // One cadence per task. The system of record carries a single ServiceRepeat
    // for the whole task, so a task whose Monday is weekly and whose Thursday is
    // biweekly cannot be written down — it is two contracts, and since the price
    // also lives on the header, it is two tasks.
    const cadences = new Set(terms.slots.map((s) => s.frequency))
    if (cadences.size > 1) {
      throw new TaskRuleError(
        `one task recurs on one cadence, got [${[...cadences].join(", ")}] — that is two tasks`,
      )
    }
  }

  /* ---------------------------------------------------------------- reads */

  get id(): string | null {
    return this._id
  }
  get ionTaskId(): string | null {
    return this._ionTaskId
  }
  get status(): "active" | "paused" | "closed" {
    return this._status
  }
  get terms(): Terms {
    return this._terms
  }
  /** True when this task has never been written outward — an add, not an edit. */
  get isNew(): boolean {
    return this._ionTaskId === null
  }
  /** How many days a week this contract is serviced. */
  get daysPerWeek(): number {
    return this._terms.slots.length
  }

  /**
   * What the customer is charged, applying the rule: an explicit price wins;
   * otherwise the catalog service type governs and we cannot state a number
   * without asking ION.
   */
  priceCents(catalogPrice: (serviceTypeId: string) => number | null): number | null {
    return this._terms.priceCents ?? catalogPrice(this._terms.serviceTypeId)
  }

  /**
   * The COMPLETE contract to write outward — never a diff. The system of
   * record stores a task's week whole, so a day omitted here is a day left
   * holding whatever it held before: a moved visit served twice, a dropped one
   * still alive.
   */
  desiredWeek(): DesiredWeek {
    const days = new Map<Weekday, string | null>()
    for (const s of this._terms.slots) days.set(s.weekday, s.techId)
    return {
      customerId: this.customerId,
      ionTaskId: this._ionTaskId,
      serviceTypeId: this._terms.serviceTypeId,
      billingMethod: this._terms.billingMethod,
      priceCents: this._terms.priceCents,
      startsOn: this._terms.startsOn,
      endsOn: this._terms.endsOn,
      // Safe by the uniform-frequency rule: every slot shares this cadence.
      frequency: this._terms.slots[0]?.frequency ?? "weekly",
      days,
      note: this._terms.note ?? "",
    }
  }

  /* --------------------------------------------------------------- edits */

  /** Restate the contract. Same validation as opening — a task cannot be edited into invalidity. */
  /**
   * Is this revision an EDIT, or a new contract?
   *
   * ION generates visits from StartsOn, so a day or cadence change cannot be
   * edited in place: rewriting the anchor re-derives visits already serviced
   * and invoiced — the reason billing needed effective-dated terms at all
   * (RULED 2026-08-05). A tech change touches no anchor and disturbs no
   * history, so it is a genuine edit.
   *
   *   I-T8 the shape of a revision is decided by WHAT MOVED, never by the
   *        caller. A caller that could choose would eventually choose to
   *        rewrite an anchor.
   */
  revisionKind(next: Terms): "amend" | "supersede" {
    const mine = [...this._terms.slots].sort((a, b) => a.weekday - b.weekday)
    const theirs = [...next.slots].sort((a, b) => a.weekday - b.weekday)
    if (mine.length !== theirs.length) return "supersede"
    for (let i = 0; i < mine.length; i++) {
      if (mine[i].weekday !== theirs[i].weekday) return "supersede"
      if (mine[i].frequency !== theirs[i].frequency) return "supersede"
    }
    // Money and service type ride on the contract too: changing what is sold
    // is a new agreement, not an edit to the old one.
    if (next.billingMethod !== this._terms.billingMethod) return "supersede"
    if (next.priceCents !== this._terms.priceCents) return "supersede"
    if (next.serviceTypeId !== this._terms.serviceTypeId) return "supersede"
    return "amend"
  }

  changeTerms(terms: Terms, at = "1970-01-01T00:00:00Z"): void {
    if (this._status === "closed") throw new TaskRuleError("a closed task cannot be changed")
    Task.validate(terms)
    const before = this._terms
    this._terms = terms
    this.recorded.push({
      type: "TaskTermsChanged",
      taskId: this._id,
      at,
      payload: { before: { ...before, slots: [...before.slots] }, after: { ...terms, slots: [...terms.slots] } },
    })
  }

  /** Move one day's work to another tech, leaving the rest of the week alone. */
  assignDay(weekday: Weekday, techId: string | null, at?: string): void {
    const slot = this._terms.slots.find((s) => s.weekday === weekday)
    if (!slot) throw new TaskRuleError(`this task is not serviced on weekday ${weekday}`)
    if (slot.techId === techId) return // no change is not an event
    this.changeTerms(
      {
        ...this._terms,
        slots: this._terms.slots.map((s) => (s.weekday === weekday ? { ...s, techId } : s)),
      },
      at,
    )
  }

  close(at = "1970-01-01T00:00:00Z", endsOn?: string): void {
    if (this._status === "closed") return
    this._status = "closed"
    if (endsOn) this._terms = { ...this._terms, endsOn }
    this.recorded.push({ type: "TaskClosed", taskId: this._id, at, payload: { endsOn: endsOn ?? null } })
  }

  /* -------------------------------------------------- identity + history */

  /**
   * Stamp the identity the outside world minted. Called once, after a create
   * lands — the aggregate cannot invent these itself.
   */
  identify(id: string, ionTaskId: string): void {
    if (this._id !== null && this._id !== id) throw new TaskRuleError("a task cannot change identity")
    this._id = id
    this._ionTaskId = ionTaskId
    for (const e of this.recorded as { taskId: string | null }[]) {
      if (e.taskId === null) e.taskId = id
    }
  }

  /**
   * Hand over the facts recorded since the last drain, and forget them. The
   * aggregate records history; it never writes it — whoever persists the task
   * appends these to the stream in the same breath (ADR 010).
   */
  pullEvents(): TaskEvent[] {
    return this.recorded.splice(0, this.recorded.length)
  }
}
