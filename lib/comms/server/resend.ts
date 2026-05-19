import "server-only"
import { Resend } from "resend"
import { EMAIL_OFFICE_BRANDING } from "../office-config"
import {
  insertPendingCommunication,
  insertEmailMessage,
  markSent,
  markFailed,
  setProviderIds,
} from "./communications-db"
import type { SendEmailRequest, SendEmailResult } from "../types"

/**
 * Resend email transport.
 *
 * Required env vars:
 *   RESEND_API_KEY    — from resend.com dashboard → API Keys
 *
 * Domain setup: each FROM address in office-config.ts must be on a domain
 * verified in your Resend account (SPF + DKIM DNS records). Reply-To addresses
 * don't need verification — they're just headers.
 */

let cachedClient: Resend | null = null

function getClient(): Resend {
  if (cachedClient) return cachedClient
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error("Missing RESEND_API_KEY env var")
  cachedClient = new Resend(apiKey)
  return cachedClient
}

function dedupeAddresses(
  base: readonly string[],
  extra: readonly string[],
  exclude: string,
): string[] {
  const seen = new Set([exclude.toLowerCase()])
  const out: string[] = []
  for (const addr of [...base, ...extra]) {
    if (addr && !seen.has(addr.toLowerCase())) {
      out.push(addr)
      seen.add(addr.toLowerCase())
    }
  }
  return out
}

export async function sendEmail(req: SendEmailRequest): Promise<SendEmailResult> {
  if (!req.lead_id && !req.customer_id && !req.task_id && !req.service_body_id) {
    return { ok: false, error: "identity_required" }
  }
  if (!req.to) return { ok: false, error: "to_required" }
  if (!req.subject) return { ok: false, error: "subject_required" }
  if (!req.body_html && !req.body_text) {
    return { ok: false, error: "body_required" }
  }
  const branding = EMAIL_OFFICE_BRANDING[req.office]
  if (!branding) return { ok: false, error: `unknown_office:${req.office}` }

  const fromName = req.from_name_override ?? branding.from_name
  const fromHeader = `${fromName} <${branding.from_address}>`
  // Caller's explicit CCs are visible to the recipient. The office archive
  // address goes in BCC so the customer never sees internal email addresses.
  const cc = req.cc && req.cc.length ? dedupeAddresses([], req.cc, req.to) : []
  const mergedBcc = dedupeAddresses(branding.auto_bcc, req.bcc ?? [], req.to)

  // Phase 1: pre-write parent + child rows BEFORE the network call.
  let communicationId: string
  try {
    communicationId = await insertPendingCommunication({
      channel: "email",
      direction: req.direction ?? "outbound",
      lead_id: req.lead_id,
      customer_id: req.customer_id,
      task_id: req.task_id,
      service_body_id: req.service_body_id,
      from_address: fromHeader,
      to_address: req.to,
      provider: "resend",
      template_name: req.template_name,
      metadata: { office: req.office, ...(req.metadata ?? {}) },
      created_by: req.created_by ?? "system:send-email",
    })
    await insertEmailMessage({
      communication_id: communicationId,
      subject: req.subject,
      body_html: req.body_html,
      body_text: req.body_text,
      cc: cc.length ? cc : undefined,
      bcc: mergedBcc.length ? mergedBcc : undefined,
      in_reply_to: req.in_reply_to,
      email_references: req.email_references,
    })
  } catch (e) {
    return { ok: false, error: `db_insert_failed:${(e as Error).message}` }
  }

  // Phase 2: call Resend
  try {
    const client = getClient()
    const headers: Record<string, string> = {}
    if (req.in_reply_to) headers["In-Reply-To"] = req.in_reply_to
    if (req.email_references) headers["References"] = req.email_references

    // Resend's CreateEmailOptions is a discriminated union — must have at
    // least one of html/text. Build conditionally and cast through unknown.
    const payload: Record<string, unknown> = {
      from: fromHeader,
      to: req.to,
      replyTo: branding.reply_to,
      subject: req.subject,
    }
    if (cc.length) payload.cc = cc
    if (mergedBcc.length) payload.bcc = mergedBcc
    if (req.body_html) payload.html = req.body_html
    if (req.body_text) payload.text = req.body_text
    if (Object.keys(headers).length) payload.headers = headers

    const { data, error } = await client.emails.send(
      payload as unknown as Parameters<typeof client.emails.send>[0],
    )
    if (error) {
      throw new Error(`${error.name ?? "ResendError"}: ${error.message ?? String(error)}`)
    }
    const messageId = data?.id
    if (!messageId) throw new Error("Resend send did not return a message id")

    await setProviderIds({
      table: "email_messages",
      communication_id: communicationId,
      fields: { provider_message_id: messageId },
    })
    await markSent({ communication_id: communicationId })

    return {
      ok: true,
      communication_id: communicationId,
      provider_message_id: messageId,
    }
  } catch (e) {
    const msg = (e as Error).message || String(e)
    await markFailed({
      communication_id: communicationId,
      error_message: msg,
    }).catch(() => {})
    return { ok: false, communication_id: communicationId, error: msg }
  }
}
