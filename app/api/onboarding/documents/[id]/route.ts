import { NextResponse } from "next/server"
import { downloadFile } from "@/lib/external/google/drive"
import { onboardingDb } from "@/lib/onboarding/infrastructure/db"
import { getOnboardingUser } from "@/lib/onboarding/infrastructure/staff-guard"
import { loadSettings } from "@/lib/onboarding/infrastructure/settings"

export const maxDuration = 60

/**
 * GET /api/onboarding/documents/<id> — streams a hiring document from Drive
 * through the app to a signed-in onboarding staff member. Drive files are
 * never shared; this route is the only way to view them outside Drive.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getOnboardingUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 })
  const db = onboardingDb()
  const { data: doc } = await db.from("documents").select("drive_file_id, filename").eq("id", id).maybeSingle()
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 })
  const s = await loadSettings(db)
  const f = await downloadFile(s.sender, doc.drive_file_id)
  return new NextResponse(new Uint8Array(f.data), {
    headers: {
      "content-type": f.contentType,
      "content-disposition": `inline; filename="${String(doc.filename).replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
    },
  })
}
