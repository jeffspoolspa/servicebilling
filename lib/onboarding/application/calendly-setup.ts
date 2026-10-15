import "server-only"
import { currentUser, listOrgEventTypes, listOrgWebhooks, createOrgWebhook } from "@/lib/external/calendly/calendly"
import { officeForEvent, type OfficeCode } from "@/lib/onboarding/domain"
import type { OnbDb } from "../infrastructure/db"
import { logEvent } from "../infrastructure/events"
import { loadRefData } from "./context"

/**
 * One-time (re-runnable) Calendly wiring, run by an onboarding admin:
 *   1. map the org's interview event types to offices and store their URIs
 *      and the scheduling link used for follow-up interviews
 *   2. create the org-scope webhook subscription (invitee.created/canceled)
 *      pointing at /api/webhooks/calendly, unless it already exists
 * Needs CALENDLY_PAT and CALENDLY_WEBHOOK_SIGNING_KEY in the app env.
 */
export async function setupCalendly(db: OnbDb, callbackUrl: string, actor: string) {
  const signingKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY
  if (!signingKey) throw new Error("CALENDLY_WEBHOOK_SIGNING_KEY is not set")
  const ref = await loadRefData(db)
  const me = await currentUser()
  const types = (await listOrgEventTypes(me.organization)).filter((t) => /interview/i.test(t.name))

  const matchers = ref.offices.map((o) => ({ code: o.code, eventTypeUris: [] as string[], nameKeywords: o.calendly_name_keywords }))
  const byOffice = new Map<OfficeCode, typeof types>()
  const unmapped: string[] = []
  for (const t of types) {
    const code = officeForEvent(null, t.name, matchers)
    if (!code) {
      unmapped.push(t.name)
      continue
    }
    byOffice.set(code, [...(byOffice.get(code) ?? []), t])
  }

  const mapping: Record<string, { eventTypes: string[]; schedulingUrl: string | null }> = {}
  for (const o of ref.offices) {
    const list = byOffice.get(o.code) ?? []
    // Follow-up link: the active, shared/collective event when there is one
    // (BWK's live event is the collective "(Shared)" one).
    const live = list.filter((t) => t.active)
    const pick = live.find((t) => /shared|collective/i.test(`${t.name} ${t.kind ?? ""}`)) ?? live[0] ?? list[0]
    const uris = Array.from(new Set([...o.calendly_event_type_uris, ...list.map((t) => t.uri)]))
    await db
      .from("offices")
      .update({ calendly_event_type_uris: uris, calendly_scheduling_url: pick?.schedulingUrl ?? o.calendly_scheduling_url })
      .eq("code", o.code)
    mapping[o.code] = { eventTypes: list.map((t) => `${t.name}${t.active ? "" : " (inactive)"}`), schedulingUrl: pick?.schedulingUrl ?? null }
  }

  const hooks = await listOrgWebhooks(me.organization)
  let webhook = hooks.find((h) => h.callbackUrl === callbackUrl && h.state === "active")
  let webhookCreated = false
  if (!webhook) {
    const uri = await createOrgWebhook(me.organization, callbackUrl, signingKey)
    webhook = { uri, callbackUrl, state: "active", events: ["invitee.created", "invitee.canceled"] }
    webhookCreated = true
  }

  const result = { calendlyUser: me.email, mapping, unmapped, webhook: { uri: webhook.uri, created: webhookCreated, callbackUrl } }
  await logEvent(db, { type: "calendly.setup", payload: result, actor })
  return result
}
