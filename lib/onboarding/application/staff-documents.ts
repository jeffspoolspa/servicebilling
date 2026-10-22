import "server-only"
import { detailProblems, missingDocs, STAFF_DOC_TYPES, UPLOAD_DOC_TYPES, type DocType, type StaffDocType, type UploadDetails } from "@/lib/onboarding/domain"
import { must, type OnbDb, type CandidateRow } from "../infrastructure/db"
import { logEvent } from "../infrastructure/events"
import { drainOutbox } from "../infrastructure/outbox"
import { setCandidateStatus } from "./context"
import { noticeOffice } from "./office-notice"
import { ReviewRuleError, type Actor } from "./review"
import { fileDocuments, signTargets } from "./submit-documents"

/**
 * Staff file documents and license details on the candidate page, for a
 * candidate who sent them some other way. Same staging bucket and Drive
 * filing as the candidate link; the bearer is the staff login, not a token.
 * When that completes what the candidate still owed, the candidate moves to
 * Docs Submitted and their open upload link is revoked.
 */
const ADVANCE_FROM = new Set(["docs_requested", "reupload_requested"])
const stagingDir = (candidateId: string) => `staff/${candidateId}/`

async function loadCandidate(db: OnbDb, id: string): Promise<CandidateRow> {
  const { data } = await db.from("candidates").select("*").eq("id", id).maybeSingle()
  if (!data) throw new ReviewRuleError("Unknown candidate.")
  return data as CandidateRow
}

export async function createStaffUploadTargets(
  db: OnbDb,
  candidateId: string,
  files: { name: string; type: string; size: number }[],
): Promise<{ path: string; token: string }[]> {
  await loadCandidate(db, candidateId)
  return signTargets(files, () => stagingDir(candidateId))
}

export async function fileStaffDocuments(
  db: OnbDb,
  candidateId: string,
  input: { docType: StaffDocType; files: { path: string; type: string; name: string }[] },
  actor: Actor,
): Promise<{ advanced: boolean; filed: number }> {
  if (!(STAFF_DOC_TYPES as readonly string[]).includes(input.docType)) throw new ReviewRuleError("Pick a document type.")
  if (!input.files.length) throw new ReviewRuleError("Add a file first.")
  for (const f of input.files) {
    if (!f.path.startsWith(stagingDir(candidateId))) throw new ReviewRuleError("Upload expired; add the files again.")
  }
  const c = await loadCandidate(db, candidateId)
  const driveName: DocType = input.docType === "Other" ? `Other - ${fileStem(input.files[0].name)}` : input.docType
  const filed = await fileDocuments(db, c, [{ docType: input.docType, driveName, files: input.files }], { source: "staff", staffId: actor.staff.id })
  await logEvent(db, {
    candidateId: c.id,
    type: "documents.staff_filed",
    payload: { type: input.docType, files: filed.map((f) => f.name) },
    actor: actor.label,
  })
  return { advanced: await advanceIfComplete(db, c, actor), filed: filed.length }
}

/** `version`: the details' updated_at the form loaded, or null when there were none (version check). */
export async function saveStaffDetails(db: OnbDb, candidateId: string, d: UploadDetails, version: string | null, actor: Actor): Promise<{ advanced: boolean }> {
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })
  const problems = detailProblems(d, todayIso)
  if (problems.length) throw new ReviewRuleError(problems[0])
  const c = await loadCandidate(db, candidateId)
  const row = {
    legal_first: d.legalFirst.trim(),
    legal_last: d.legalLast.trim(),
    dob: d.dob,
    dl_number: d.dlNumber.replace(/\s|-/g, ""),
    dl_state: "GA",
    dl_expires: d.dlExpires,
    licensed_3_years: d.licensed3Years,
    entered_by_staff_id: actor.staff.id,
  }
  const stale = () => new ReviewRuleError("Someone changed these details since you opened them. Reload to see them, then edit again.")
  if (version === null) {
    const ins = await db.from("candidate_details").insert({ candidate_id: c.id, ...row }).select("candidate_id")
    if (ins.error?.code === "23505") throw stale()
    must(ins, "save details")
  } else {
    const upd = must<{ candidate_id: string }[]>(
      await db.from("candidate_details").update(row).eq("candidate_id", c.id).eq("updated_at", version).select("candidate_id"),
      "save details",
    )
    if (!upd.length) throw stale()
  }
  // No DOB or DL number in the log (events.ts).
  await logEvent(db, { candidateId: c.id, type: "details.staff_saved", actor: actor.label })
  return { advanced: await advanceIfComplete(db, c, actor) }
}

/** Docs Requested / Re-upload Requested -> Docs Submitted once every required document is live and details exist. */
async function advanceIfComplete(db: OnbDb, c: CandidateRow, actor: Actor): Promise<boolean> {
  if (!ADVANCE_FROM.has(c.status)) return false
  const docs = must<{ doc_type: string; review_status: string }[]>(
    await db.from("documents").select("doc_type, review_status").eq("candidate_id", c.id).in("doc_type", [...UPLOAD_DOC_TYPES]),
    "load documents",
  )
  if (missingDocs(docs).length) return false
  const { data: det } = await db.from("candidate_details").select("candidate_id").eq("candidate_id", c.id).maybeSingle()
  if (!det) return false
  await db
    .from("upload_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("candidate_id", c.id)
    .is("used_at", null)
    .is("revoked_at", null)
  await setCandidateStatus(db, c, "docs_submitted", actor.label, "completed by staff")
  const n = await noticeOffice(db, c.id, "documents complete", `Filed by ${actor.label} on the candidate page`, `staff_complete:${c.id}:${Date.now()}`)
  if (n) await drainOutbox(db, { onlyIds: [n] }).catch(() => undefined)
  return true
}

function fileStem(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[^\w .-]/g, "").trim().slice(0, 40) || "Document"
}
