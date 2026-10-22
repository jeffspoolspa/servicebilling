import "server-only"
import { OFFICE_CODES, POSITIONS, rotateEmails, tenDigitPhone, type OfficeCode } from "@/lib/onboarding/domain"
import { must, type OnbDb, type CandidateRow } from "../infrastructure/db"
import { logEvent } from "../infrastructure/events"
import { easternTime } from "../infrastructure/internal-emails"
import { ReviewRuleError, type Actor } from "./review"

/**
 * Staff correct what a person typed about a candidate (name, email, phone,
 * office, position, summary notes). Status, recommendation, score, grade and
 * pay rate stay with the steps that set them. Version check: `version` is the
 * updated_at the form loaded; the save matches only that value, so an edit
 * made in between is never overwritten. An old email is kept in
 * previous_emails (bookings under it still find the candidate) and queued
 * emails are re-pointed to the new address.
 */
export interface CandidateEdit {
  firstName: string
  lastName: string
  email: string
  phone: string
  officeCode: OfficeCode
  position: string
  summaryNotes: string | null
}

export async function editCandidate(db: OnbDb, candidateId: string, e: CandidateEdit, version: string, actor: Actor): Promise<{ changed: string[] }> {
  const first = e.firstName.trim()
  const last = e.lastName.trim()
  const email = e.email.trim().toLowerCase()
  if (!first || !last) throw new ReviewRuleError("First and last name are required.")
  // No quotes, commas or parentheses: the duplicate check below builds a PostgREST filter.
  if (!/^[^\s@",()]+@[^\s@",()]+\.[^\s@",()]+$/.test(email)) throw new ReviewRuleError("Enter a valid email.")
  if (!tenDigitPhone(e.phone)) throw new ReviewRuleError("Enter a 10-digit phone number.")
  if (!(OFFICE_CODES as readonly string[]).includes(e.officeCode)) throw new ReviewRuleError("Pick an office.")
  if (!(POSITIONS as readonly string[]).includes(e.position)) throw new ReviewRuleError("Pick a position.")

  const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", candidateId).single(), "load candidate")
  const next = {
    first_name: first,
    last_name: last,
    email,
    phone: e.phone.trim(),
    office_code: e.officeCode,
    position: e.position,
    summary_notes: e.summaryNotes?.trim() || null,
  }
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => (c[k] ?? null) !== next[k])
  if (!changed.length) throw new ReviewRuleError("Nothing changed.")

  const emailChanged = changed.includes("email")
  if (emailChanged) {
    const taken = must<{ id: string }[]>(
      await db.from("candidates").select("id").neq("id", c.id).or(`email.eq."${email}",previous_emails.cs.{"${email}"}`).limit(1),
      "check email",
    )
    if (taken.length) throw new ReviewRuleError("Another candidate already uses that email.")
  }

  const upd = await db
    .from("candidates")
    .update({ ...next, ...(emailChanged ? { previous_emails: rotateEmails(c.previous_emails ?? [], c.email, email) } : {}) })
    .eq("id", c.id)
    .eq("updated_at", version)
    .select("id")
  if (upd.error?.code === "23505") throw new ReviewRuleError("Another candidate already uses that email.")
  if (!must<{ id: string }[]>(upd, "save candidate").length) {
    const now = must<{ updated_at: string }>(await db.from("candidates").select("updated_at").eq("id", c.id).single(), "reload candidate")
    throw new ReviewRuleError(`Someone changed this candidate at ${easternTime(now.updated_at)}. Reload to see it, then edit again.`)
  }

  if (emailChanged) {
    // Queued (not yet sent) emails still carry the old address.
    const queued = must<{ id: string; to_addrs: string[] }[]>(
      await db.from("outbound_emails").select("id, to_addrs").eq("candidate_id", c.id).eq("channel", "email").eq("status", "queued").contains("to_addrs", [c.email]),
      "load queued emails",
    )
    for (const q of queued) {
      await db
        .from("outbound_emails")
        .update({ to_addrs: q.to_addrs.map((a) => (a.toLowerCase() === c.email.toLowerCase() ? email : a)) })
        .eq("id", q.id)
        .eq("status", "queued")
    }
  }
  await logEvent(db, {
    candidateId: c.id,
    type: "candidate.edited",
    payload: { fields: changed, ...(emailChanged ? { email_from: c.email, email_to: email } : {}) },
    actor: actor.label,
  })
  return { changed }
}
