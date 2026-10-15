import type { OfficeCode } from "./status"

/**
 * Pure rules for turning a Calendly booking into a candidate + interview.
 * No Calendly types here: the ACL (lib/external/calendly) hands us these
 * structural shapes.
 */
export interface BookingHost {
  email: string
  name?: string | null
}

export interface OfficeMatcher {
  code: OfficeCode
  eventTypeUris: string[]
  nameKeywords: string[]
}

/** Office from the event type: exact URI first, then name keywords. */
export function officeForEvent(
  eventTypeUri: string | null,
  eventName: string | null,
  offices: OfficeMatcher[],
): OfficeCode | null {
  if (eventTypeUri) {
    const byUri = offices.find((o) => o.eventTypeUris.includes(eventTypeUri))
    if (byUri) return byUri.code
  }
  const name = (eventName ?? "").toLowerCase().replace(/[–—]/g, "-")
  // Office code in the name ("Interview - BWK") also counts.
  for (const o of offices) {
    if (new RegExp(`\\b${o.code.toLowerCase()}\\b`).test(name)) return o.code
  }
  for (const o of offices) {
    if (o.nameKeywords.some((k) => name.includes(k.toLowerCase()))) return o.code
  }
  return null
}

/**
 * The person interviewing. Collective events list every host; shared
 * mailboxes (jpsbilling, jpsretail) are never the interviewer, so the first
 * non-shared host wins. Null = only shared hosts -> office default.
 */
export function personalHost(hosts: BookingHost[], sharedMailboxes: string[]): BookingHost | null {
  const shared = new Set(sharedMailboxes.map((e) => e.toLowerCase()))
  return hosts.find((h) => h.email && !shared.has(h.email.toLowerCase())) ?? null
}

/** The phone answer: the required "Phone Number"/"Mobile phone" question. */
export function phoneFromAnswers(
  answers: { question: string; answer: string | null }[],
  fallback?: string | null,
): string | null {
  const q = answers.find((a) => /phone|mobile|cell/i.test(a.question) && a.answer && a.answer.trim())
  return q?.answer?.trim() ?? (fallback?.trim() || null)
}

/** Split Calendly's single "name" when first/last weren't collected. */
export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/)
  if (parts.length === 1) return { first: parts[0], last: "" }
  return { first: parts[0], last: parts.slice(1).join(" ") }
}

export function isTestCandidate(email: string, first: string, last: string, testEmails: string[]): boolean {
  const e = email.trim().toLowerCase()
  if (testEmails.some((t) => t.toLowerCase() === e)) return true
  return /^test\b/i.test(first.trim()) || /^test\b/i.test(last.trim())
}
