import "server-only"
import { createHash, randomBytes } from "node:crypto"
import type { UploadDocType } from "@/lib/onboarding/domain"
import { must, type OnbDb, type CandidateRow } from "../infrastructure/db"
import { logEvent } from "../infrastructure/events"

/**
 * Candidate upload links. The raw token lives only in the emailed/texted
 * link; the table keeps its SHA-256. Issuing a new link revokes older open
 * links for the same candidate, so only the newest one works.
 */
export interface UploadTokenRow {
  id: string
  candidate_id: string
  purpose: "initial" | "reupload"
  requested_docs: UploadDocType[]
  note: string | null
  expires_at: string
  used_at: string | null
  revoked_at: string | null
}

export const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex")

export async function issueUploadToken(
  db: OnbDb,
  candidateId: string,
  opts: { purpose: "initial" | "reupload"; requestedDocs?: UploadDocType[]; note?: string | null },
  appBaseUrl: string,
): Promise<{ url: string; tokenId: string }> {
  await db
    .from("upload_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("candidate_id", candidateId)
    .is("used_at", null)
    .is("revoked_at", null)
  const raw = randomBytes(32).toString("base64url")
  const row = must<{ id: string }[]>(
    await db
      .from("upload_tokens")
      .insert({
        candidate_id: candidateId,
        token_hash: hashToken(raw),
        purpose: opts.purpose,
        requested_docs: opts.requestedDocs ?? [],
        note: opts.note ?? null,
      })
      .select("id"),
    "create upload token",
  )[0]
  await logEvent(db, { candidateId, type: "upload_link.created", payload: { purpose: opts.purpose, docs: opts.requestedDocs ?? [], expires_days: 14 } })
  return { url: `${appBaseUrl}/service/onboarding/upload/${raw}`, tokenId: row.id }
}

export type TokenState =
  | { ok: true; token: UploadTokenRow; candidate: CandidateRow }
  | { ok: false; reason: "invalid" | "expired" | "used" }

export async function resolveUploadToken(db: OnbDb, raw: string): Promise<TokenState> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(raw)) return { ok: false, reason: "invalid" }
  const { data } = await db.from("upload_tokens").select("*").eq("token_hash", hashToken(raw)).maybeSingle()
  const token = data as UploadTokenRow | null
  if (!token || token.revoked_at) return { ok: false, reason: "invalid" }
  if (token.used_at) return { ok: false, reason: "used" }
  if (new Date(token.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" }
  const candidate = must<CandidateRow>(await db.from("candidates").select("*").eq("id", token.candidate_id).single(), "load candidate")
  return { ok: true, token, candidate }
}
