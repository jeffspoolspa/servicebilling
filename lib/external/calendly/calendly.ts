import "server-only"
import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Calendly API v2 ACL. Calendly vocabulary stops here: callers get the
 * structural `BookingFact`, never raw webhook JSON.
 *
 * Env:
 *   CALENDLY_PAT                    personal access token (jpsbilling, org owner)
 *   CALENDLY_WEBHOOK_SIGNING_KEY    the signing_key given when the subscription
 *                                   was created (setup route passes it)
 */
const API = "https://api.calendly.com"

// ------------------------------------------------------------ webhook in

/**
 * Header `Calendly-Webhook-Signature: t=<unix>,v1=<hex>`; v1 is
 * HMAC-SHA256(signing_key, `${t}.${rawBody}`). Rejects anything older than
 * 5 minutes (replay window).
 */
export function verifyWebhook(rawBody: string, header: string | null, signingKey: string, nowMs = Date.now()): boolean {
  if (!header) return false
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=")
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]
    }),
  )
  const t = Number(parts.t)
  const v1 = parts.v1
  if (!t || !v1) return false
  if (Math.abs(nowMs / 1000 - t) > 300) return false
  const expected = createHmac("sha256", signingKey).update(`${t}.${rawBody}`).digest("hex")
  const a = Buffer.from(expected)
  const b = Buffer.from(v1)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface BookingFact {
  kind: "created" | "canceled"
  inviteeUri: string
  eventUri: string
  eventTypeUri: string | null
  eventName: string | null
  startAt: string
  endAt: string
  email: string
  firstName: string | null
  lastName: string | null
  fullName: string
  answers: { question: string; answer: string | null }[]
  textReminderNumber: string | null
  hosts: { email: string; name: string | null }[]
  /** created: this booking replaces old_invitee (a reschedule). */
  oldInviteeUri: string | null
  /** canceled: true when the cancel is the first half of a reschedule. */
  rescheduled: boolean
  canceledBy: string | null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function decodeWebhook(body: any): BookingFact | null {
  const ev = body?.event
  if (ev !== "invitee.created" && ev !== "invitee.canceled") return null
  const p = body.payload ?? {}
  const se = p.scheduled_event ?? {}
  return {
    kind: ev === "invitee.created" ? "created" : "canceled",
    inviteeUri: String(p.uri ?? ""),
    eventUri: String(p.event ?? se.uri ?? ""),
    eventTypeUri: se.event_type ?? null,
    eventName: se.name ?? null,
    startAt: String(se.start_time ?? ""),
    endAt: String(se.end_time ?? se.start_time ?? ""),
    email: String(p.email ?? "").trim(),
    firstName: p.first_name ?? null,
    lastName: p.last_name ?? null,
    fullName: String(p.name ?? "").trim(),
    answers: Array.isArray(p.questions_and_answers)
      ? p.questions_and_answers.map((qa: any) => ({ question: String(qa.question ?? ""), answer: qa.answer ?? null }))
      : [],
    textReminderNumber: p.text_reminder_number ?? null,
    hosts: Array.isArray(se.event_memberships)
      ? se.event_memberships
          .filter((m: any) => m?.user_email)
          .map((m: any) => ({ email: String(m.user_email), name: m.user_name ?? null }))
      : [],
    oldInviteeUri: p.old_invitee ?? null,
    rescheduled: Boolean(p.rescheduled),
    canceledBy: p.cancellation?.canceled_by ?? null,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ------------------------------------------------------------ API out

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const pat = process.env.CALENDLY_PAT
  if (!pat) throw new Error("CALENDLY_PAT is not set")
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${pat}`)
  headers.set("content-type", "application/json")
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, { ...init, headers })
  const text = await res.text()
  if (!res.ok) throw new Error(`calendly ${init.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : {}) as T
}

export interface CalendlyEventType {
  uri: string
  name: string
  active: boolean
  schedulingUrl: string
  kind: string | null
}

export async function currentUser(): Promise<{ uri: string; organization: string; email: string }> {
  const r = await api<{ resource: { uri: string; current_organization: string; email: string } }>("/users/me")
  return { uri: r.resource.uri, organization: r.resource.current_organization, email: r.resource.email }
}

export async function listOrgEventTypes(organization: string): Promise<CalendlyEventType[]> {
  const out: CalendlyEventType[] = []
  let next: string | null = `/event_types?${new URLSearchParams({ organization, count: "100" })}`
  while (next) {
    const r: {
      collection: { uri: string; name: string; active: boolean; scheduling_url: string; pooling_type: string | null; kind: string | null }[]
      pagination: { next_page: string | null }
    } = await api(next)
    for (const e of r.collection) {
      out.push({ uri: e.uri, name: e.name, active: e.active, schedulingUrl: e.scheduling_url, kind: e.pooling_type ?? e.kind })
    }
    next = r.pagination?.next_page ?? null
  }
  return out
}

export async function listOrgWebhooks(organization: string): Promise<{ uri: string; callbackUrl: string; state: string; events: string[] }[]> {
  const r = await api<{ collection: { uri: string; callback_url: string; state: string; events: string[] }[] }>(
    `/webhook_subscriptions?${new URLSearchParams({ organization, scope: "organization", count: "100" })}`,
  )
  return r.collection.map((w) => ({ uri: w.uri, callbackUrl: w.callback_url, state: w.state, events: w.events }))
}

export async function createOrgWebhook(organization: string, callbackUrl: string, signingKey: string): Promise<string> {
  const r = await api<{ resource: { uri: string } }>("/webhook_subscriptions", {
    method: "POST",
    body: JSON.stringify({
      url: callbackUrl,
      events: ["invitee.created", "invitee.canceled"],
      organization,
      scope: "organization",
      signing_key: signingKey,
    }),
  })
  return r.resource.uri
}
