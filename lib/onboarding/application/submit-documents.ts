import "server-only"
import { randomUUID } from "node:crypto"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { htmlToPdf } from "@/lib/external/pdf/render"
import {
  SLOT_DOC_TYPE,
  SLOTS_FOR_DOC,
  UPLOAD_DOC_TYPES,
  MAX_FILE_BYTES,
  REVIEW_EMAIL_MAX_BYTES,
  RECOMMENDATION_LABEL,
  detailProblems,
  type DocType,
  type StaffDocType,
  type UploadSlot,
  type UploadDocType,
  type UploadDetails,
} from "@/lib/onboarding/domain"
import { must, type OnbDb, type CandidateRow } from "../infrastructure/db"
import { logEvent } from "../infrastructure/events"
import { enqueueEmail, drainOutbox } from "../infrastructure/outbox"
import { uploadCandidateDoc } from "../infrastructure/candidate-drive"
import { escapeHtml } from "../infrastructure/settings"
import { loadRefData, officeName, setCandidateStatus } from "./context"
import { resolveUploadToken, type UploadTokenRow } from "./upload-tokens"

export const UPLOAD_BUCKET = "onboarding-uploads"
const ALLOWED_MIME = /^(image\/(jpeg|png|webp)|application\/pdf)$/

export class UploadRuleError extends Error {}

/** Which documents this link asks for (initial: all three). */
export function docsForToken(t: Pick<UploadTokenRow, "purpose" | "requested_docs">): UploadDocType[] {
  return t.purpose === "reupload" && t.requested_docs.length ? t.requested_docs : [...UPLOAD_DOC_TYPES]
}

/**
 * Step 1: signed upload URLs into the private staging bucket, one per file.
 * Browser uploads go straight to storage (Vercel caps function bodies at
 * 4.5 MB). Paths are namespaced by token id so submit can verify them.
 */
export async function createUploadTargets(
  db: OnbDb,
  rawToken: string,
  files: { slot: UploadSlot; name: string; type: string; size: number }[],
): Promise<{ slot: UploadSlot; path: string; token: string }[]> {
  const st = await resolveUploadToken(db, rawToken)
  if (!st.ok) throw new UploadRuleError("This upload link is no longer valid.")
  for (const f of files) if (!(f.slot in SLOT_DOC_TYPE)) throw new UploadRuleError("Unknown document.")
  const signed = await signTargets(files, (i) => `${st.token.id}/${files[i].slot}/`)
  return signed.map((s, i) => ({ slot: files[i].slot, ...s }))
}

/** Signed upload URLs in the staging bucket, file i under dir(i). Shared by the candidate and staff doors. */
export async function signTargets(
  files: { name: string; type: string; size: number }[],
  dir: (i: number) => string,
): Promise<{ path: string; token: string }[]> {
  if (files.length === 0 || files.length > 20) throw new UploadRuleError("Add your documents first.")
  const admin = createSupabaseAdmin()
  const out: { path: string; token: string }[] = []
  for (const [i, f] of files.entries()) {
    if (!ALLOWED_MIME.test(f.type)) throw new UploadRuleError(`${f.name}: upload a photo or a PDF.`)
    if (f.size > MAX_FILE_BYTES) throw new UploadRuleError(`${f.name} is over 20 MB.`)
    const ext = f.type === "application/pdf" ? "pdf" : f.type.split("/")[1]
    const path = `${dir(i)}${randomUUID()}.${ext}`
    const { data, error } = await admin.storage.from(UPLOAD_BUCKET).createSignedUploadUrl(path)
    if (error || !data) throw new Error(`signed upload url: ${error?.message}`)
    out.push({ path, token: data.token })
  }
  return out
}

/** One document's staged files: photos become one PDF, each PDF files as itself. */
export interface FileGroup {
  docType: StaffDocType
  driveName: DocType
  files: { path: string; type: string }[]
}

/**
 * Staged files -> Drive -> onboarding.documents. New rows go in before the
 * older copies of the required types are superseded, so a failure part-way
 * never leaves a candidate with no live copy.
 */
export async function fileDocuments(
  db: OnbDb,
  candidate: CandidateRow,
  groups: FileGroup[],
  by: { source: "upload"; uploadTokenId: string } | { source: "staff"; staffId: string },
): Promise<{ docType: StaffDocType; fileId: string; name: string; size: number }[]> {
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })
  const admin = createSupabaseAdmin()
  const filed: { docType: StaffDocType; fileId: string; name: string; size: number }[] = []
  for (const g of groups) {
    const blobs: { type: string; data: Buffer }[] = []
    for (const f of g.files) {
      const { data, error } = await admin.storage.from(UPLOAD_BUCKET).download(f.path)
      if (error || !data) throw new UploadRuleError("An upload didn't finish. Please add that file again.")
      blobs.push({ type: data.type || f.type, data: Buffer.from(await data.arrayBuffer()) })
    }
    const images = blobs.filter((b) => b.type.startsWith("image/"))
    const pdfs = blobs.filter((b) => b.type === "application/pdf")
    const outputs: Buffer[] = [...pdfs.map((p) => p.data)]
    if (images.length) outputs.unshift(await imagesToPdf(images))
    for (const pdf of outputs) {
      const f = await uploadCandidateDoc(db, candidate, g.driveName, todayIso, "pdf", "application/pdf", pdf)
      filed.push({ docType: g.docType, fileId: f.fileId, name: f.name, size: pdf.length })
    }
  }

  const ids = must<{ id: string }[]>(
    await db
      .from("documents")
      .insert(
        filed.map((f) => ({
          candidate_id: candidate.id,
          doc_type: f.docType,
          drive_file_id: f.fileId,
          filename: f.name,
          size_bytes: f.size,
          source: by.source,
          upload_token_id: by.source === "upload" ? by.uploadTokenId : null,
          uploaded_by_staff_id: by.source === "staff" ? by.staffId : null,
        })),
      )
      .select("id"),
    "save documents",
  ).map((r) => r.id)
  // One live copy per required type: the new one supersedes the earlier ones.
  const required = groups.map((g) => g.docType).filter((t): t is UploadDocType => (UPLOAD_DOC_TYPES as readonly string[]).includes(t))
  if (required.length) {
    await db
      .from("documents")
      .update({ review_status: "superseded" })
      .eq("candidate_id", candidate.id)
      .in("doc_type", required)
      .in("source", ["upload", "staff"])
      .not("id", "in", `(${ids.join(",")})`)
  }
  await admin.storage.from(UPLOAD_BUCKET).remove(groups.flatMap((g) => g.files.map((f) => f.path)))
  return filed
}

export interface SubmitInput {
  details: UploadDetails | null // null on a re-upload link
  files: { slot: UploadSlot; path: string; type: string }[]
}

/**
 * Step 2: validate, move staged files to Drive (images -> one PDF per
 * document), save the details, mark the link used, set Docs Submitted and
 * queue the review email to the office.
 */
export async function submitDocuments(db: OnbDb, rawToken: string, input: SubmitInput): Promise<{ candidateId: string }> {
  const st = await resolveUploadToken(db, rawToken)
  if (!st.ok) throw new UploadRuleError("This upload link is no longer valid.")
  const { token, candidate } = st
  const wanted = docsForToken(token)
  const todayIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })

  if (token.purpose === "initial") {
    if (!input.details) throw new UploadRuleError("Fill in your license details.")
    const problems = detailProblems(input.details, todayIso)
    if (problems.length) throw new UploadRuleError(problems[0])
  }
  for (const f of input.files) {
    if (!f.path.startsWith(`${token.id}/${f.slot}/`)) throw new UploadRuleError("Upload expired; please add the files again.")
  }
  for (const doc of wanted) {
    for (const slot of SLOTS_FOR_DOC[doc]) {
      if (!input.files.some((f) => f.slot === slot)) throw new UploadRuleError(`Missing: ${slotLabel(slot)}.`)
    }
  }

  const filed = await fileDocuments(
    db,
    candidate,
    wanted.map((doc) => ({
      docType: doc,
      driveName: doc,
      // Keep slot order (front before back), then upload order.
      files: input.files
        .filter((f) => SLOTS_FOR_DOC[doc].includes(f.slot))
        .sort((a, b) => SLOTS_FOR_DOC[doc].indexOf(a.slot) - SLOTS_FOR_DOC[doc].indexOf(b.slot)),
    })),
    { source: "upload", uploadTokenId: token.id },
  )

  // ---- record
  if (token.purpose === "initial" && input.details) {
    const d = input.details
    must(
      await db
        .from("candidate_details")
        .upsert({
          candidate_id: candidate.id,
          legal_first: d.legalFirst.trim(),
          legal_last: d.legalLast.trim(),
          dob: d.dob,
          dl_number: d.dlNumber.replace(/\s|-/g, ""),
          dl_state: "GA",
          dl_expires: d.dlExpires,
          licensed_3_years: d.licensed3Years,
          entered_by_staff_id: null,
          updated_at: new Date().toISOString(),
        })
        .select("candidate_id"),
      "save details",
    )
  }
  await db.from("upload_tokens").update({ used_at: new Date().toISOString() }).eq("id", token.id)
  await logEvent(db, {
    candidateId: candidate.id,
    type: "documents.submitted",
    payload: { purpose: token.purpose, files: filed.map((f) => ({ type: f.docType, name: f.name })) },
    actor: "candidate",
  })
  await setCandidateStatus(db, candidate, "docs_submitted", "candidate", token.purpose === "reupload" ? "re-upload" : "upload page")

  const outboxId = await queueReviewEmail(db, candidate.id, token.purpose === "reupload")
  if (outboxId) await drainOutbox(db, { onlyIds: [outboxId] }).catch(() => undefined)
  return { candidateId: candidate.id }
}

/** "Last, First - Hiring Documents (review)" to the review recipients, docs attached. */
export async function queueReviewEmail(db: OnbDb, candidateId: string, isReupload: boolean): Promise<string | null> {
  const ref = await loadRefData(db)
  const s = ref.settings
  const c = must<CandidateRow>(await db.from("candidates").select("*").eq("id", candidateId).single(), "load candidate")
  const docs = must<{ id: string; doc_type: string; drive_file_id: string; filename: string; size_bytes: number | null; uploaded_at: string }[]>(
    await db
      .from("documents")
      .select("id, doc_type, drive_file_id, filename, size_bytes, uploaded_at")
      .eq("candidate_id", candidateId)
      .in("source", ["upload", "staff"])
      .neq("review_status", "superseded")
      .order("uploaded_at"),
    "load documents",
  )
  const order = ["MVR", "Drivers License", "Criminal History"]
  docs.sort((a, b) => order.indexOf(a.doc_type) - order.indexOf(b.doc_type))
  let attach = docs
  let note = ""
  const total = docs.reduce((n, d) => n + (d.size_bytes ?? 0), 0)
  if (total > REVIEW_EMAIL_MAX_BYTES) {
    attach = docs.filter((d) => d.doc_type !== "Criminal History")
    note = "<p><em>The criminal history report is not attached (the files were over 20 MB together). Open it on the approval page.</em></p>"
  }
  const reviewUrl = `${s.appBaseUrl}/service/onboarding/candidates/${c.id}/review`
  const row = (k: string, v: string) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#666">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`
  const html =
    `<p>${escapeHtml(c.first_name)} ${escapeHtml(c.last_name)} ${isReupload ? "re-uploaded" : "submitted"} hiring documents.</p>` +
    `<table style="font:14px sans-serif;border-collapse:collapse">` +
    row("Office", `${c.office_code ?? "?"} · ${officeName(ref, c.office_code)}`) +
    row("Position", c.position) +
    row("Grade", c.grade ? `${c.grade} (${Number(c.overall_score).toFixed(1)})` : "—") +
    row("Recommendation", c.recommendation ? RECOMMENDATION_LABEL[c.recommendation] : "—") +
    row("Summary notes", c.summary_notes ?? "—") +
    `</table>` +
    `<p style="margin-top:14px"><a href="${escapeHtml(reviewUrl)}" style="background:#0e7490;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font:600 14px sans-serif">Review and approve</a></p>` +
    `<p><strong>Approval checklist</strong> (all required):</p><ul>` +
    s.approvalChecklist.map((i) => `<li>${escapeHtml(i.label)}</li>`).join("") +
    `</ul>` +
    note +
    `<p style="color:#666;font:12px sans-serif">Attached: ${escapeHtml(attach.map((d) => d.filename).join(", ") || "none")}</p>`
  const { id } = await enqueueEmail(db, {
    candidateId: c.id,
    kind: "review",
    dedupeKey: `review:${c.id}:${docs.map((d) => d.id).join(",")}`,
    to: s.reviewRecipients,
    subject: `${c.last_name}, ${c.first_name} - Hiring Documents (review)`,
    html,
    attachments: attach.map((d) => ({ drive_file_id: d.drive_file_id, filename: d.filename })),
  })
  return id
}

function slotLabel(slot: UploadSlot): string {
  return { mvr: "your 3-year MVR", dl_front: "the front of your license", dl_back: "the back of your license", criminal: "your criminal history report" }[slot]
}

/** Photos -> one letter-size PDF, one image per page. */
async function imagesToPdf(images: { type: string; data: Buffer }[]): Promise<Buffer> {
  const pages = images
    .map(
      (img) =>
        `<div class="p"><img src="data:${img.type};base64,${img.data.toString("base64")}"/></div>`,
    )
    .join("")
  return htmlToPdf(`<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:letter;margin:0.4in} body{margin:0}
    .p{height:10.1in;display:flex;align-items:center;justify-content:center;page-break-after:always}
    .p:last-child{page-break-after:auto}
    img{max-width:100%;max-height:100%;object-fit:contain}
  </style></head><body>${pages}</body></html>`)
}
