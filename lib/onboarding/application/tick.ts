import "server-only"
import { must, type OnbDb, type InterviewRow } from "../infrastructure/db"
import { drainOutbox, type DrainResult } from "../infrastructure/outbox"
import { logEvent } from "../infrastructure/events"
import { loadRefData } from "./context"
import { queuePreInterview, queueScorecardReminder } from "./pre-interview"
import { fileScorecardPdf } from "./submit-scorecard"

/**
 * The onboarding heartbeat (pg_cron every 5 min -> /api/onboarding/tick).
 * Level-triggered: each step looks at current state and queues whatever is
 * due; the outbox dedupe keys make repeats harmless.
 *
 *   1. 15-minute heads-up for interviews starting within 15 min
 *   2. one scorecard reminder 2 h after an interview ends with no scorecard
 *   3. retry scorecard PDFs that failed to reach Drive
 *   4. send everything due (incl. 24 h-delayed rejections)
 */
export interface TickResult {
  preQueued: number
  remindersQueued: number
  pdfsFiled: number
  outbox: DrainResult
}

export async function runTick(db: OnbDb): Promise<TickResult> {
  const ref = await loadRefData(db)
  const now = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()

  const pre = must<InterviewRow[]>(
    await db
      .from("interviews")
      .select("*")
      .eq("status", "scheduled")
      .is("pre_email_sent_at", null)
      .gt("start_at", iso(now - 30 * 60_000))
      .lte("start_at", iso(now + 15 * 60_000)),
    "due pre-interview",
  )
  for (const iv of pre) await queuePreInterview(db, ref, iv)

  const late = must<InterviewRow[]>(
    await db
      .from("interviews")
      .select("*")
      .eq("status", "scheduled")
      .is("reminder_sent_at", null)
      .lte("end_at", iso(now - 2 * 3600_000))
      .gte("end_at", iso(now - 3 * 24 * 3600_000)),
    "due reminders",
  )
  for (const iv of late) await queueScorecardReminder(db, ref, iv)

  const missingPdf = must<{ id: string }[]>(
    await db
      .from("scorecards")
      .select("id")
      .is("pdf_drive_file_id", null)
      .lte("created_at", iso(now - 2 * 60_000))
      .order("created_at")
      .limit(3),
    "scorecards without pdf",
  )
  let pdfsFiled = 0
  for (const { id } of missingPdf) {
    try {
      await fileScorecardPdf(db, ref, id)
      pdfsFiled++
    } catch {
      /* logged in fileScorecardPdf */
    }
  }

  const outbox = await drainOutbox(db)
  const result = { preQueued: pre.length, remindersQueued: late.length, pdfsFiled, outbox }
  if (pre.length || late.length || pdfsFiled || outbox.sent || outbox.failed || outbox.canceled) {
    await logEvent(db, { type: "tick", payload: result as unknown as Record<string, unknown>, actor: "pg_cron" })
  }
  return result
}
