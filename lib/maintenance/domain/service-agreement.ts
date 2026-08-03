/**
 * ServiceAgreement — what service we agreed to give one customer at one
 * place. The middle of the spine: lead -> service agreement -> task.
 *
 * This is where cadence, rate and pool live, NOT on the customer. A customer
 * is who someone is; an agreement is what we promised them. A billing-only
 * customer has no agreement, and Customers must never depend on Maintenance
 * (the dependency points this way, never back).
 *
 * An agreement is what Task.open consumes: the task is the agreement made
 * real in ION, and the ION anchor date is computed from the agreement's
 * cadence, never guessed.
 */

/* --------------------------------- cadence -------------------------------- */

export type Cadence = "weekly" | "biweekly_a" | "biweekly_b" | "monthly"

export type CadenceResolution =
  | { kind: "resolved"; cadence: Cadence; weekdays: number[] }
  | { kind: "ambiguous"; reason: string; candidates: { cadence: Cadence; weekdays: number[] }[] }

const WEEKDAY: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

export function parseServiceDays(raw: string): number[] {
  return raw
    .split(/[,/&]| and /i)
    .map((s) => WEEKDAY[s.trim().toLowerCase()])
    .filter((d): d is number => d !== undefined)
}

/** weekly = 1 visit/week, bi-weekly = 1/2 — the load a stop puts on a day. */
export const loadOf = (c: string) => (c === "weekly" ? 1 : c.startsWith("biweekly") ? 0.5 : 0.25)

/**
 * An acquisition row's service columns -> our cadence, or an honest
 * ambiguity. The rules:
 *  - the SERVICE WEEK field is the authority ("Every week" = weekly,
 *    "Week A/B" = biweekly_a/b); free-text frequency mixes cadence with
 *    flavour ("Bi-Weekly Indoor Spa") and is not trusted for the decision
 *  - a bi-weekly visit is ONE stop from one anchor date [I-M6]; two listed
 *    days is observed day-drift, not a schedule
 *  - "weekly" with two days is genuinely two visits only if the money agrees
 *    (monthly ~= rate x 8.66); otherwise it is the same drift
 */
export function resolveCadence(args: {
  frequencyText: string
  serviceDaysText: string
  weekText: string | null
  ratePerVisit: number | null
  monthly: number | null
}): CadenceResolution {
  const days = parseServiceDays(args.serviceDaysText)
  const week = (args.weekText ?? "").trim().toLowerCase()
  const cadence: Cadence | null = /every\s*week/.test(week)
    ? "weekly"
    : /\ba\b/.test(week)
      ? "biweekly_a"
      : /\bb\b/.test(week)
        ? "biweekly_b"
        : null

  if (!cadence) return { kind: "ambiguous", reason: `service week "${args.weekText}" is neither Every week nor Week A/B`, candidates: [] }
  if (days.length === 0) return { kind: "ambiguous", reason: `no recognizable service day in "${args.serviceDaysText}"`, candidates: [] }
  if (days.length === 1) return { kind: "resolved", cadence, weekdays: days }

  if (cadence === "weekly") {
    const visitsPerMonth = args.ratePerVisit && args.monthly ? args.monthly / args.ratePerVisit : null
    if (visitsPerMonth !== null && visitsPerMonth > 6.5) return { kind: "resolved", cadence, weekdays: days }
    return {
      kind: "ambiguous",
      reason: `weekly with ${days.length} listed days but the money says ~${visitsPerMonth?.toFixed(1) ?? "?"} visits/month (one day) — drift; pick the cheaper day`,
      candidates: days.map((d) => ({ cadence, weekdays: [d] })),
    }
  }
  return {
    kind: "ambiguous",
    reason: `bi-weekly is one stop (I-M6) but the sheet lists ${days.length} days — drift; pick the cheaper day`,
    candidates: days.map((d) => ({ cadence, weekdays: [d] })),
  }
}

/* ------------------------------ the agreement ----------------------------- */

export interface AgreementTerms {
  customerId: number
  /** The place the truck goes — the ServiceLocation entity's identity. */
  placeId: string | null
  cadence: Cadence
  weekday: number
  ratePerVisit: number | null
  monthlyEstimate: number | null
  poolType: string
  /** Access facts the tech needs on the visit; NOT a dumping ground. */
  gateCode: string
}

/**
 * A settled agreement. Constructed only from a RESOLVED cadence, so an
 * ambiguity can never travel downstream disguised as a schedule.
 */
export class ServiceAgreement {
  private constructor(readonly terms: AgreementTerms) {}

  static from(
    terms: Omit<AgreementTerms, "cadence" | "weekday"> & { cadence: CadenceResolution },
  ): ServiceAgreement | { refused: string } {
    if (terms.cadence.kind !== "resolved") return { refused: terms.cadence.reason }
    if (terms.cadence.weekdays.length !== 1 && terms.cadence.cadence !== "weekly") {
      return { refused: `${terms.cadence.cadence} cannot serve ${terms.cadence.weekdays.length} days from one anchor` }
    }
    return new ServiceAgreement({ ...terms, cadence: terms.cadence.cadence, weekday: terms.cadence.weekdays[0] })
  }

  /** What ION needs said about this agreement's schedule. */
  get schedule(): { cadence: Cadence; weekday: number } {
    return { cadence: this.terms.cadence, weekday: this.terms.weekday }
  }

  /** The note a tech should see on the visit — the gate code, or nothing. */
  get visitNote(): string {
    return this.terms.gateCode.trim() ? `gate code: ${this.terms.gateCode.trim()}` : ""
  }

  get effectiveLoad(): number {
    return loadOf(this.terms.cadence)
  }
}
