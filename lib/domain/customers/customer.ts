/**
 * The Customers domain: what a customer must BE before any system hears about
 * them, and how far along their onboarding is.
 *
 * Two doors, one set of rules. Everything WE create flows through the factory
 * (`draftCustomer`), which refuses a draft that does not fit. Customers born
 * directly in QBO cannot be refused — QBO is the leader — so the same rules
 * (`customerFit`) run AFTER the fact and flag. The rules object is shared;
 * only the consequence differs.
 *
 * Onboarding state is never a stamped status column. It is DERIVED from the
 * two external references (QBO, ION), each a value with explicit states —
 * because "null ion_cust_id" conflates never-tried, not-synced-yet, and
 * genuinely-ambiguous, and those demand different actions.
 */

/* ----------------------------- external refs ----------------------------- */

/** A deferred reference into another system. The durable form of a promise. */
export type ExternalRef =
  | { state: "unlinked" }
  | { state: "awaiting"; since: string; attempts: number }
  | { state: "linked"; id: string; method: string; confidence: string; at: string }
  | { state: "ambiguous"; candidates: { id: string; name: string }[] }

/** ADR 006's four columns, read as one meaning. */
export function ionRefFrom(row: {
  ion_cust_id: string | null
  ion_match_method: string | null
  ion_match_confidence: string | null
  ion_matched_at: string | null
}): ExternalRef {
  if (row.ion_cust_id) {
    return {
      state: "linked",
      id: row.ion_cust_id,
      method: row.ion_match_method ?? "unknown",
      confidence: row.ion_match_confidence ?? "unknown",
      at: row.ion_matched_at ?? "",
    }
  }
  return { state: "unlinked" }
}

/* ------------------------------- the rules ------------------------------- */

export interface Violation {
  rule: string
  detail: string
  /** blocking = the factory refuses; advisory = flagged, work proceeds. */
  blocking: boolean
}

export interface CustomerShape {
  firstName: string
  lastName: string
  street: string
  city: string
  state: string
  zip: string
  phone: string | null
  email: string | null
}

/**
 * Does this fit our domain? ONE implementation, both doors.
 * City and zip are blocking because geocoding without a city pins the wrong
 * town (ADR 007) — a street-only address is how pins ended up in the wrong
 * city on the routing map.
 */
export function customerFit(c: CustomerShape): Violation[] {
  const v: Violation[] = []
  if (!c.firstName || !c.lastName) v.push({ rule: "name", detail: "needs a first and last name", blocking: true })
  if (!c.street) v.push({ rule: "service-address", detail: "no service street", blocking: true })
  if (!c.city) v.push({ rule: "service-city", detail: "no city — geocoding would guess the town", blocking: true })
  if (!/^\d{5}$/.test(c.zip)) v.push({ rule: "service-zip", detail: `zip "${c.zip}" is not 5 digits`, blocking: true })
  if (!c.phone && !c.email) v.push({ rule: "contact", detail: "no phone and no email — unreachable", blocking: true })
  if (!c.email) v.push({ rule: "email", detail: "no email — invoices go by mail or SMS only", blocking: false })
  if (c.phone && c.phone.replace(/\D/g, "").length !== 10) {
    v.push({ rule: "phone", detail: `phone "${c.phone}" is not 10 digits`, blocking: false })
  }
  return v
}

/* --------------------------- the service profile -------------------------- */

/**
 * What the row says about SERVICE — carried on the draft for the task step,
 * validated now so one report covers everything. Cadence vocabulary is ours:
 * weekly / biweekly_a / biweekly_b (parity per the ION anchor rule).
 */
export type CadenceResolution =
  | { kind: "resolved"; frequency: "weekly" | "biweekly_a" | "biweekly_b"; weekdays: number[] }
  | { kind: "ambiguous"; reason: string; candidates: { frequency: string; weekdays: number[] }[] }

export interface ServiceProfile {
  cadence: CadenceResolution
  ratePerVisit: number | null
  monthly: number | null
  notes: string[]
}

const WEEKDAY: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

export function parseServiceDays(raw: string): number[] {
  return raw
    .split(/[,/&]| and /i)
    .map((s) => WEEKDAY[s.trim().toLowerCase()])
    .filter((d): d is number => d !== undefined)
}

/**
 * Sheet row -> our cadence, or an honest ambiguity. The rules this encodes:
 *  - the SERVICE WEEK field is the cadence authority ("Every week" = weekly,
 *    "Week A/B" = biweekly_a/b) — the Frequency text on this sheet mixes
 *    cadence with flavor ("Weekly & Bi-Weekly", "Bi-Weekly Indoor Spa") and
 *    is not trusted for the decision
 *  - a bi-weekly visit is ONE stop from one start date (invariant I6); two
 *    listed days is observed day-drift, not a schedule — the candidates go to
 *    the drive-cost resolver, which picks the cheaper day
 *  - "weekly" with two days is genuinely two visits ONLY if the money agrees
 *    (monthly ≈ rate x 8.66); otherwise it is the same drift
 *  - Week A/B maps to biweekly_a/b — verified against the ION anchor rule for
 *    the sheet's own reference week (Mon 2026-08-03 = their A = our a)
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
  const frequency = /every\s*week/.test(week)
    ? ("weekly" as const)
    : /\ba\b/.test(week)
      ? ("biweekly_a" as const)
      : /\bb\b/.test(week)
        ? ("biweekly_b" as const)
        : null

  if (!frequency) {
    return { kind: "ambiguous", reason: `service week "${args.weekText}" is neither Every week nor Week A/B`, candidates: [] }
  }
  if (days.length === 0) {
    return { kind: "ambiguous", reason: `no recognizable service day in "${args.serviceDaysText}"`, candidates: [] }
  }
  if (days.length === 1) {
    return { kind: "resolved", frequency, weekdays: days }
  }

  if (frequency === "weekly") {
    const visitsPerMonth = args.ratePerVisit && args.monthly ? args.monthly / args.ratePerVisit : null
    // ~4.33 visits/month = one day a week whose day drifted; ~8.66 = truly two days.
    if (visitsPerMonth !== null && visitsPerMonth > 6.5) {
      return { kind: "resolved", frequency, weekdays: days }
    }
    return {
      kind: "ambiguous",
      reason: `weekly with ${days.length} listed days but the money says ~${visitsPerMonth?.toFixed(1) ?? "?"} visits/month (one day) — drift; pick the cheaper day`,
      candidates: days.map((d) => ({ frequency, weekdays: [d] })),
    }
  }
  return {
    kind: "ambiguous",
    reason: `bi-weekly is one stop (I6) but the sheet lists ${days.length} days — drift; pick the cheaper day`,
    candidates: days.map((d) => ({ frequency, weekdays: [d] })),
  }
}

/* ------------------------------- the factory ------------------------------ */

export interface RawCustomerRow {
  name: string
  street: string
  city: string
  zip: string
  phone: string
  email: string
  frequencyText: string
  serviceDaysText: string
  weekText: string | null
  ratePerVisit: number | null
  monthly: number | null
  gateCode: string
  poolType: string
  segment: string
  billingNote: string
}

export interface CustomerDraft {
  shape: CustomerShape
  displayName: string
  profile: ServiceProfile
  violations: Violation[]
}

export const isBlocked = (d: CustomerDraft) => d.violations.some((v) => v.blocking)

/**
 * The factory: a raw row in, a normalized draft out, with every objection
 * attached. Pure — no IO, no ids from other systems, nothing external.
 */
export function draftCustomer(row: RawCustomerRow): CustomerDraft {
  const name = row.name.replace(/\s+/g, " ").trim()
  const lastSpace = name.lastIndexOf(" ")
  const firstName = lastSpace > 0 ? name.slice(0, lastSpace) : name
  const lastName = lastSpace > 0 ? name.slice(lastSpace + 1) : ""

  // Real-world contact cells hold several values ("a@x.com / b@y.com").
  // Downstream systems take ONE (QBO refuses a multi-email string outright,
  // and its phone field caps at 21 chars) — so the first is primary and the
  // rest ride along as notes instead of poisoning the write.
  const split = (v: string) => v.split(/[\/;,]| or /i).map((t) => t.trim()).filter(Boolean)
  const emails = split(row.email).map((e) => e.toLowerCase())
  const phones = [...new Set(split(row.phone))]

  const shape: CustomerShape = {
    firstName,
    lastName,
    street: row.street.trim(),
    city: row.city.trim(),
    state: "GA",
    zip: String(row.zip).trim(),
    phone: phones[0] ?? null,
    email: emails[0] ?? null,
  }

  const cadence = resolveCadence(row)
  const violations = customerFit(shape)
  if (cadence.kind === "ambiguous") {
    violations.push({ rule: "cadence", detail: cadence.reason, blocking: true })
  }
  if (/\?/.test(row.poolType)) {
    violations.push({ rule: "pool-type", detail: `pool type "${row.poolType}" is uncertain`, blocking: false })
  }

  const notes = [
    ...emails.slice(1).map((e) => `alt email: ${e}`),
    ...phones.slice(1).map((ph) => `alt phone: ${ph}`),
    row.segment && `segment: ${row.segment}`,
    row.poolType && `pool: ${row.poolType}`,
    row.gateCode && `gate code: ${row.gateCode}`,
    row.billingNote && `billing: ${row.billingNote}`,
  ].filter((n): n is string => Boolean(n))

  return {
    shape,
    displayName: `${lastName.toUpperCase()}, ${firstName.toUpperCase()}`,
    profile: { cadence, ratePerVisit: row.ratePerVisit, monthly: row.monthly, notes },
    violations,
  }
}

/* ----------------------------- the aggregate ------------------------------ */

/** What onboarding is waiting on, derived — never stamped. */
export type OnboardingState = "drafted" | "billing_created" | "awaiting_ion" | "linked" | "ambiguous"

export class Customer {
  constructor(
    readonly id: string,
    readonly qbo: ExternalRef,
    readonly ion: ExternalRef,
  ) {}

  get onboarding(): OnboardingState {
    if (this.ion.state === "linked") return "linked"
    if (this.ion.state === "ambiguous") return "ambiguous"
    if (this.qbo.state === "linked") return "awaiting_ion"
    return "drafted"
  }

  /** Why an action is not available yet — null when it is. */
  blocks(action: "create_task"): string | null {
    if (action === "create_task" && this.ion.state !== "linked") {
      return `cannot create an ION task: this customer's ION link is ${this.ion.state}`
    }
    return null
  }
}
