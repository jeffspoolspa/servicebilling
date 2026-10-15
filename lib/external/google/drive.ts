import "server-only"
import { randomBytes } from "node:crypto"
import { SCOPES, googleFetch, googleJson } from "./service-account"

/**
 * Drive access as the impersonated owner of the JPS Hiring root. Files are
 * NEVER shared: no permissions calls exist in this module on purpose.
 */
const FOLDER_MIME = "application/vnd.google-apps.folder"
const API = "https://www.googleapis.com/drive/v3/files"

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")

interface DriveFile {
  id: string
  name: string
  mimeType?: string
}

export async function listChildrenByName(owner: string, parentId: string, name: string, foldersOnly = false): Promise<DriveFile[]> {
  const query = [`'${q(parentId)}' in parents`, `name = '${q(name)}'`, "trashed = false"]
  if (foldersOnly) query.push(`mimeType = '${FOLDER_MIME}'`)
  const url = `${API}?${new URLSearchParams({ q: query.join(" and "), fields: "files(id,name,mimeType)", pageSize: "10" })}`
  const res = await googleJson<{ files: DriveFile[] }>(owner, [SCOPES.drive], url)
  return res.files ?? []
}

/** Reuse an exact-name folder under parent, or create it. */
export async function ensureFolder(owner: string, parentId: string, name: string): Promise<string> {
  const existing = await listChildrenByName(owner, parentId, name, true)
  if (existing[0]) return existing[0].id
  const created = await googleJson<DriveFile>(owner, [SCOPES.drive], `${API}?fields=id,name`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  })
  return created.id
}

/** `name.ext` -> `name (2).ext`, `name (3).ext`, ... until free. Never overwrites. */
export async function freeName(owner: string, parentId: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  let candidate = name
  for (let n = 2; n < 50; n++) {
    if ((await listChildrenByName(owner, parentId, candidate)).length === 0) return candidate
    candidate = `${stem} (${n})${ext}`
  }
  throw new Error(`no free file name for ${name}`)
}

export async function uploadFile(
  owner: string,
  parentId: string,
  name: string,
  contentType: string,
  data: Buffer,
): Promise<DriveFile> {
  const boundary = `drv_${randomBytes(8).toString("hex")}`
  const meta = JSON.stringify({ name, parents: [parentId] })
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  const res = await googleFetch(
    owner,
    [SCOPES.drive],
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name",
    { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body },
  )
  const text = await res.text()
  if (!res.ok) throw new Error(`drive upload failed (${res.status}): ${text.slice(0, 300)}`)
  return JSON.parse(text) as DriveFile
}

/** Bytes of a file, for streaming through the app (never a share link). */
export async function downloadFile(owner: string, fileId: string): Promise<{ data: Buffer; contentType: string }> {
  const res = await googleFetch(owner, [SCOPES.drive], `${API}/${encodeURIComponent(fileId)}?alt=media`)
  if (!res.ok) throw new Error(`drive download failed (${res.status})`)
  return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" }
}
