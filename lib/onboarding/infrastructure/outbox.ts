import "server-only"
import { sendMail, type MailAttachment } from "@/lib/external/google/gmail"
import { downloadFile } from "@/lib/external/google/drive"
import { brandFor, withBrand, DEFAULT_BRAND } from "./brand"
import { sendText } from "@/lib/external/ringcentral/sms"
import type { Office as RcOffice } from "@/lib/comms/types"
import { must, type OnbDb, type CandidateRow, type InterviewRow } from "./db"
import { logEvent } from "./events"
import { loadSettings, escapeHtml, type OnboardingSettings } from "./settings"

/**
 * The only writer of onboarding.outbound_emails. Every email the context
 * sends is enqueued here (idempotent on dedupe_key) and sent by drain().
 *
 * Safety rails, applied at SEND time so a settings change also covers mail
 * already queued:
 *   - test candidate      -> every recipient becomes settings.test_recipient
 *   - live_mode = false   -> every recipient outside @jeffspoolspa.com
 *                            becomes settings.test_recipient
 *   Rewritten mail gets a "[TEST]" subject and a banner naming the
 *   original recipients.
 */
export type EmailKind =
  | "pre_interview"
  | "scorecard_reminder"
  | "rejection"
  | "follow_up"
  | "hire"
  | "hire_sms"
  | "review"
  | "reupload"
  | "reupload_sms"
  | "office_notice"

export interface Enqueue {
  candidateId: string | null
  interviewId?: string | null
  kind: EmailKind
  dedupeKey: string
  to: string[]
  cc?: string[]
  subject: string
  html: string
  sendAfter?: Date
  /** Cancel instead of send if the candidate's status is no longer this. */
  requireStatus?: string | null
  /**
   * 'sms': `to` holds phone numbers and `html` the plain-text body; the
   * sending number is the candidate office's offices.sms_sender.
   */
  channel?: "email" | "sms"
  /** Drive files attached at send time (fetched fresh, never stored here). */
  attachments?: { drive_file_id: string; filename: string }[]
}

// Company mailboxes: never rewritten in test mode (Richmond Hill staff share
// info@perfectpoolscleaning.com).
const INTERNAL_DOMAINS = ["@jeffspoolspa.com", "@perfectpoolscleaning.com"]

/** Mail to the candidate carries the office brand (RH = Perfect Pools); staff mail doesn't. */
const CANDIDATE_KINDS: ReadonlySet<EmailKind> = new Set(["rejection", "follow_up", "hire", "hire_sms", "reupload", "reupload_sms"])

export async function enqueueEmail(db: OnbDb, e: Enqueue): Promise<{ id: string; created: boolean }> {
  const row = {
    candidate_id: e.candidateId,
    interview_id: e.interviewId ?? null,
    kind: e.kind,
    dedupe_key: e.dedupeKey,
    to_addrs: uniq(e.to),
    cc_addrs: uniq(e.cc ?? []).filter((c) => !e.to.map(lc).includes(lc(c))),
    subject: e.subject,
    body_html: e.html,
    send_after: (e.sendAfter ?? new Date()).toISOString(),
    require_status: e.requireStatus ?? null,
    channel: e.channel ?? "email",
    attachments: e.attachments ?? [],
  }
  const ins = await db.from("outbound_emails").upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id")
  const created = must<{ id: string }[] | null>(ins, "enqueue email") ?? []
  if (created[0]) return { id: created[0].id, created: true }
  const existing = must<{ id: string }>(
    await db.from("outbound_emails").select("id").eq("dedupe_key", e.dedupeKey).single(),
    "find queued email",
  )
  return { id: existing.id, created: false }
}

export interface DrainResult {
  sent: number
  canceled: number
  failed: number
}

/** Send everything due. Bounded per call; the next tick takes the rest. */
export async function drainOutbox(db: OnbDb, opts: { onlyIds?: string[]; limit?: number } = {}): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, canceled: 0, failed: 0 }
  const settings = await loadSettings(db)

  // Interrupted sends (crash mid-send) are failed, never auto-retried: a
  // retry could double-send. The portal's Resend button re-queues them.
  await db
    .from("outbound_emails")
    .update({ status: "failed", last_error: "interrupted while sending; use Resend" })
    .eq("status", "sending")
    .lt("claimed_at", new Date(Date.now() - 15 * 60_000).toISOString())

  let q = db
    .from("outbound_emails")
    .select("id")
    .eq("status", "queued")
    .lte("send_after", new Date().toISOString())
    .order("send_after")
    .limit(opts.limit ?? 25)
  if (opts.onlyIds?.length) q = q.in("id", opts.onlyIds)
  const due = must<{ id: string }[]>(await q, "list due email")

  for (const { id } of due) {
    // Claim: only one drainer wins a row.
    const claimed = must<OutboxRow[]>(
      await db.from("outbound_emails").update({ status: "sending", claimed_at: new Date().toISOString() }).eq("id", id).eq("status", "queued").select("*"),
      "claim email",
    )
    const row = claimed[0]
    if (!row) continue
    const outcome = await sendOne(db, row, settings)
    result[outcome]++
  }
  return result
}

interface OutboxRow {
  id: string
  candidate_id: string | null
  interview_id: string | null
  kind: EmailKind
  dedupe_key: string
  to_addrs: string[]
  cc_addrs: string[]
  subject: string
  body_html: string
  require_status: string | null
  attempts: number
  channel: "email" | "sms"
  attachments: { drive_file_id: string; filename: string }[] | null
}

async function sendOne(db: OnbDb, row: OutboxRow, s: OnboardingSettings): Promise<"sent" | "canceled" | "failed"> {
  let candidate: Pick<CandidateRow, "status" | "is_test" | "office_code"> | null = null
  if (row.candidate_id) {
    candidate = must(
      await db.from("candidates").select("status, is_test, office_code").eq("id", row.candidate_id).single(),
      "load candidate",
    )
  }

  const cancelReason = await staleReason(db, row, candidate)
  if (cancelReason) {
    await db.from("outbound_emails").update({ status: "canceled", last_error: cancelReason }).eq("id", row.id)
    await logEvent(db, {
      candidateId: row.candidate_id,
      type: `email.${row.kind}.canceled`,
      status: "skipped",
      payload: { outbox_id: row.id, reason: cancelReason },
    })
    return "canceled"
  }

  const brand = CANDIDATE_KINDS.has(row.kind) ? brandFor(s.officeBrands, candidate?.office_code) : DEFAULT_BRAND
  row = { ...row, subject: withBrand(row.subject, brand), body_html: withBrand(row.body_html, brand) }
  if (row.channel === "sms") return sendSmsRow(db, row, s, candidate)

  const { to, cc, subject, html, rewritten } = applyRails(row, s, candidate?.is_test ?? false)
  try {
    const attachments: MailAttachment[] = []
    for (const a of row.attachments ?? []) {
      const f = await downloadFile(s.sender, a.drive_file_id)
      attachments.push({ filename: a.filename, contentType: f.contentType, data: f.data })
    }
    const msg = await sendMail(s.sender, {
      from: `${brand.name} <${s.sender}>`,
      replyTo: brand.reply_to,
      to,
      cc,
      subject,
      html,
      attachments,
    })
    await db
      .from("outbound_emails")
      .update({ status: "sent", sent_at: new Date().toISOString(), gmail_message_id: msg.id, attempts: row.attempts + 1, last_error: null })
      .eq("id", row.id)
    if (row.kind === "pre_interview" && row.interview_id) {
      await db.from("interviews").update({ pre_email_sent_at: new Date().toISOString() }).eq("id", row.interview_id)
    }
    if (row.kind === "scorecard_reminder" && row.interview_id) {
      await db.from("interviews").update({ reminder_sent_at: new Date().toISOString() }).eq("id", row.interview_id)
    }
    await logEvent(db, {
      candidateId: row.candidate_id,
      type: `email.${row.kind}.sent`,
      payload: { outbox_id: row.id, to, cc, rewritten },
    })
    return "sent"
  } catch (err) {
    const attempts = row.attempts + 1
    const message = err instanceof Error ? err.message : String(err)
    const retry = attempts < 3
    await db
      .from("outbound_emails")
      .update({
        status: retry ? "queued" : "failed",
        attempts,
        last_error: message.slice(0, 1000),
        send_after: new Date(Date.now() + attempts * 5 * 60_000).toISOString(),
      })
      .eq("id", row.id)
    await logEvent(db, {
      candidateId: row.candidate_id,
      type: `email.${row.kind}.${retry ? "retry" : "failed"}`,
      status: "error",
      payload: { outbox_id: row.id, attempts },
      error: message,
    })
    return "failed"
  }
}

/**
 * Texts: every phone number is "outside the company", so with live_mode off
 * (or for a test candidate) the text goes to settings.test_phone instead.
 * Sent from the candidate office's RingCentral number (offices.sms_sender).
 */
async function sendSmsRow(
  db: OnbDb,
  row: OutboxRow,
  s: OnboardingSettings,
  candidate: Pick<CandidateRow, "is_test" | "office_code"> | null,
): Promise<"sent" | "failed"> {
  const rewritten = Boolean(candidate?.is_test) || !s.liveMode
  const to = rewritten ? [s.testPhone] : row.to_addrs
  const body = rewritten ? `[TEST for ${row.to_addrs.join(", ")}] ${row.body_html}` : row.body_html
  try {
    const { data: office } = await db.from("offices").select("sms_sender").eq("code", candidate?.office_code ?? "BWK").maybeSingle()
    const sender = ((office as { sms_sender?: RcOffice } | null)?.sms_sender ?? "brunswick") as RcOffice
    const ids: string[] = []
    for (const phone of to) ids.push((await sendText(sender, phone, body)).id)
    await db
      .from("outbound_emails")
      .update({ status: "sent", sent_at: new Date().toISOString(), gmail_message_id: ids.join(","), attempts: row.attempts + 1, last_error: null })
      .eq("id", row.id)
    await logEvent(db, { candidateId: row.candidate_id, type: `sms.${row.kind}.sent`, payload: { outbox_id: row.id, to, from_office: sender, rewritten } })
    return "sent"
  } catch (err) {
    const attempts = row.attempts + 1
    const message = err instanceof Error ? err.message : String(err)
    const retry = attempts < 3
    await db
      .from("outbound_emails")
      .update({
        status: retry ? "queued" : "failed",
        attempts,
        last_error: message.slice(0, 1000),
        send_after: new Date(Date.now() + attempts * 5 * 60_000).toISOString(),
      })
      .eq("id", row.id)
    await logEvent(db, { candidateId: row.candidate_id, type: `sms.${row.kind}.${retry ? "retry" : "failed"}`, status: "error", payload: { outbox_id: row.id, attempts }, error: message })
    return "failed"
  }
}

/** Why a queued email should no longer go out, or null. */
async function staleReason(
  db: OnbDb,
  row: OutboxRow,
  candidate: Pick<CandidateRow, "status"> | null,
): Promise<string | null> {
  if (row.require_status && candidate && candidate.status !== row.require_status) {
    return `candidate status is now ${candidate.status}`
  }
  if ((row.kind === "pre_interview" || row.kind === "scorecard_reminder") && row.interview_id) {
    const iv = must<Pick<InterviewRow, "status" | "start_at">>(
      await db.from("interviews").select("status, start_at").eq("id", row.interview_id).single(),
      "load interview",
    )
    if (iv.status !== "scheduled") return `interview is ${iv.status}`
    if (row.kind === "pre_interview") {
      // dedupe key carries the start it was queued for: pre15:<id>:<iso>
      const queuedFor = row.dedupe_key.split(":").slice(2).join(":")
      if (queuedFor && new Date(queuedFor).getTime() !== new Date(iv.start_at).getTime()) return "interview was rescheduled"
    }
  }
  return null
}

export function applyRails(
  row: Pick<OutboxRow, "to_addrs" | "cc_addrs" | "subject" | "body_html">,
  s: Pick<OnboardingSettings, "liveMode" | "testRecipient">,
  isTest: boolean,
): { to: string[]; cc: string[]; subject: string; html: string; rewritten: boolean } {
  const swap = (addr: string) => (isTest || (!s.liveMode && !INTERNAL_DOMAINS.some((d) => lc(addr).endsWith(d))) ? s.testRecipient : addr)
  const to = uniq(row.to_addrs.map(swap))
  const cc = uniq(row.cc_addrs.map(swap)).filter((c) => !to.map(lc).includes(lc(c)))
  const rewritten =
    to.join(",") !== uniq(row.to_addrs).join(",") || cc.join(",") !== uniq(row.cc_addrs).join(",")
  if (!rewritten) return { to, cc, subject: row.subject, html: row.body_html, rewritten }
  const banner =
    `<div style="border:1px solid #c90;background:#fff8e1;padding:8px 10px;margin-bottom:12px;font:12px sans-serif">` +
    `<strong>TEST MODE</strong> (${isTest ? "test candidate" : "live mode off"}): this would have gone to ` +
    `${escapeHtml(row.to_addrs.join(", "))}${row.cc_addrs.length ? ` cc ${escapeHtml(row.cc_addrs.join(", "))}` : ""}.</div>`
  return { to, cc, subject: `[TEST] ${row.subject}`, html: banner + row.body_html, rewritten }
}

function lc(s: string) {
  return s.trim().toLowerCase()
}
function uniq(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of list.map((x) => x.trim()).filter(Boolean)) {
    if (!seen.has(lc(a))) {
      seen.add(lc(a))
      out.push(a)
    }
  }
  return out
}
