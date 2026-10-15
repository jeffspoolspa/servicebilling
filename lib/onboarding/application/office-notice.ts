import "server-only"
import { STATUS_LABEL, type CandidateStatus } from "@/lib/onboarding/domain"
import { must, type OnbDb, type CandidateRow } from "../infrastructure/db"
import { enqueueEmail } from "../infrastructure/outbox"
import { escapeHtml, loadSettings } from "../infrastructure/settings"

/**
 * One-line pipeline update to the office mailbox (jpsbilling) at each step,
 * with a link to the candidate's page. Queued, never blocks the step; the
 * caller's drain (or the next tick) sends it. Test candidates go to the
 * test recipient like every other email.
 */
export async function noticeOffice(
  db: OnbDb,
  candidateId: string,
  event: string,
  detail: string,
  dedupe: string,
): Promise<string | null> {
  try {
    const s = await loadSettings(db)
    const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", candidateId).single(), "load candidate")
    const url = `${s.appBaseUrl}/service/onboarding/candidates/${c.id}/review`
    const { id } = await enqueueEmail(db, {
      candidateId: c.id,
      kind: "office_notice",
      dedupeKey: `notice:${dedupe}`,
      to: [s.sender],
      subject: `Hiring: ${c.first_name} ${c.last_name} (${c.office_code ?? "?"}) – ${event}`,
      html:
        `<p><strong>${escapeHtml(c.first_name)} ${escapeHtml(c.last_name)}</strong> (${escapeHtml(c.office_code ?? "?")}) – ${escapeHtml(event)}</p>` +
        (detail ? `<p>${escapeHtml(detail)}</p>` : "") +
        `<p>Status: ${escapeHtml(STATUS_LABEL[c.status as CandidateStatus] ?? c.status)}</p>` +
        `<p><a href="${escapeHtml(url)}">Open candidate</a> · <a href="${escapeHtml(s.appBaseUrl)}/service/onboarding/candidates">All candidates</a></p>`,
    })
    return id
  } catch (err) {
    console.error("[onboarding] office notice failed", err)
    return null
  }
}
