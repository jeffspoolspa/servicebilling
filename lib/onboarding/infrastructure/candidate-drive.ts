import "server-only"
import { ensureFolder, freeName, uploadFile } from "@/lib/external/google/drive"
import { personFolderName, docFileName, type DocType } from "@/lib/onboarding/domain"
import { must, type OnbDb, type CandidateRow } from "./db"
import { loadSettings } from "./settings"

/**
 * The candidate's folder directly under JPS Hiring, reused by exact name
 * (the seed session may have created it). Stores the id on the candidate.
 * The root owner is the sender mailbox (jpsbilling).
 */
export async function ensureCandidateFolder(db: OnbDb, c: CandidateRow): Promise<string> {
  if (c.drive_folder_id) return c.drive_folder_id
  const s = await loadSettings(db)
  const id = await ensureFolder(s.sender, s.driveRootId, personFolderName(c.last_name, c.first_name, c.is_test))
  must(await db.from("candidates").update({ drive_folder_id: id }).eq("id", c.id).select("id"), "save folder id")
  return id
}

export async function uploadCandidateDoc(
  db: OnbDb,
  c: CandidateRow,
  docType: DocType,
  isoDate: string,
  ext: string,
  contentType: string,
  data: Buffer,
): Promise<{ fileId: string; name: string }> {
  const s = await loadSettings(db)
  const folderId = await ensureCandidateFolder(db, c)
  const name = await freeName(s.sender, folderId, docFileName(c.last_name, c.first_name, docType, isoDate, ext))
  const file = await uploadFile(s.sender, folderId, name, contentType, data)
  return { fileId: file.id, name }
}
