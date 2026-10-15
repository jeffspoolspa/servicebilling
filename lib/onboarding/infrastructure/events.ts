import "server-only"
import type { OnbDb } from "./db"

/**
 * Append-only side-effect log (onboarding.events). Never put document
 * contents, DOB or DL numbers in payload.
 */
export interface EventInput {
  candidateId?: string | null
  type: string
  status?: "ok" | "error" | "skipped"
  payload?: Record<string, unknown>
  error?: string | null
  actor?: string | null
}

export async function logEvent(db: OnbDb, e: EventInput): Promise<void> {
  const { error } = await db.from("events").insert({
    candidate_id: e.candidateId ?? null,
    type: e.type,
    status: e.status ?? "ok",
    payload: e.payload ?? {},
    error: e.error ? e.error.slice(0, 2000) : null,
    actor: e.actor ?? null,
  })
  if (error) console.error("[onboarding] event log failed", e.type, error.message)
}
