import Link from "next/link"
import { requireOnboardingStaff } from "@/lib/onboarding/infrastructure/staff-guard"
import { onboardingDb, type CandidateRow, type InterviewRow } from "@/lib/onboarding/infrastructure/db"
import { loadRefData } from "@/lib/onboarding/application/context"
import { STATUS_LABEL, RECOMMENDATION_LABEL, CANDIDATE_STATUSES, OFFICE_CODES, type CandidateStatus } from "@/lib/onboarding/domain"
import { easternTime } from "@/lib/onboarding/infrastructure/internal-emails"

export const dynamic = "force-dynamic"

const NEXT_ACTION: Partial<Record<CandidateStatus, string>> = {
  scheduled: "Interview",
  interviewed: "Scorecard outcome",
  follow_up: "Waiting: candidate books 2nd interview",
  docs_requested: "Waiting: candidate uploads documents",
  docs_submitted: "Review documents",
  reupload_requested: "Waiting: candidate re-uploads",
  approved: "Create in Gusto, send Marsh draft",
  gusto_invited: "Waiting: Gusto onboarding",
}

/** /service/onboarding/candidates — the pipeline table. */
export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; office?: string; q?: string }>
}) {
  await requireOnboardingStaff()
  const sp = await searchParams
  const db = onboardingDb()
  const ref = await loadRefData(db)
  let q = db.from("candidates").select("*").order("created_at", { ascending: false }).limit(300)
  if (sp.status && (CANDIDATE_STATUSES as readonly string[]).includes(sp.status)) q = q.eq("status", sp.status)
  if (sp.office && (OFFICE_CODES as readonly string[]).includes(sp.office)) q = q.eq("office_code", sp.office)
  const { data: cands } = await q
  let rows = (cands ?? []) as CandidateRow[]
  if (sp.q?.trim()) {
    const needle = sp.q.trim().toLowerCase()
    rows = rows.filter((c) => `${c.first_name} ${c.last_name}`.toLowerCase().includes(needle))
  }
  const { data: ivs } = await db
    .from("interviews")
    .select("candidate_id, start_at, interviewer_staff_id, status")
    .in("candidate_id", rows.map((r) => r.id).length ? rows.map((r) => r.id) : ["00000000-0000-0000-0000-000000000000"])
    .order("start_at", { ascending: false })
  const latest = new Map<string, Pick<InterviewRow, "start_at" | "interviewer_staff_id">>()
  for (const iv of (ivs ?? []) as InterviewRow[]) if (!latest.has(iv.candidate_id)) latest.set(iv.candidate_id, iv)
  rows.sort((a, b) => (latest.get(b.id)?.start_at ?? b.created_at).localeCompare(latest.get(a.id)?.start_at ?? a.created_at))

  const days = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  const sel = "bg-[#0E1C2A] border border-line rounded-md px-2.5 py-1.5 text-[13px] text-ink"

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-display tracking-tight">Candidates</h1>
        <p className="text-ink-dim text-[13px]">Everyone in the hiring pipeline, newest interview first.</p>
      </div>
      <form className="flex flex-wrap gap-2 items-center">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Search name" className={sel} />
        <select name="office" defaultValue={sp.office ?? ""} className={sel}>
          <option value="">All offices</option>
          {OFFICE_CODES.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        <select name="status" defaultValue={sp.status ?? ""} className={sel}>
          <option value="">All statuses</option>
          {CANDIDATE_STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
        <button className="h-8 px-3 text-xs rounded-md border border-line hover:border-cyan">Filter</button>
      </form>
      <div className="bg-bg-elev border border-line rounded-lg overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-ink-mute text-[11px] uppercase tracking-[0.1em]">
            <tr className="border-b border-line-soft">
              {["Name", "Office", "Interview", "Interviewer", "Grade", "Rec.", "Status", "Next action", "Days", "Notes"].map((h) => (
                <th key={h} className="text-left px-3 py-2 font-normal whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const iv = latest.get(c.id)
              return (
                <tr key={c.id} className="border-b border-line-soft hover:bg-white/[0.03]">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Link href={`/service/onboarding/candidates/${c.id}/review`} className="text-cyan hover:underline">
                      {c.first_name} {c.last_name}
                    </Link>
                    {c.is_test && <span className="ml-1.5 text-[10px] text-sun">TEST</span>}
                  </td>
                  <td className="px-3 py-2">{c.office_code ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{iv ? easternTime(iv.start_at) : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{ref.staff.find((s) => s.id === iv?.interviewer_staff_id)?.name ?? "—"}</td>
                  <td className="px-3 py-2">{c.grade ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{c.recommendation ? RECOMMENDATION_LABEL[c.recommendation] : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{STATUS_LABEL[c.status]}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-dim">{NEXT_ACTION[c.status] ?? "—"}</td>
                  <td className="px-3 py-2">{days(c.status_changed_at)}</td>
                  <td className="px-3 py-2 max-w-[260px] truncate text-ink-dim">{c.summary_notes ?? ""}</td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-ink-mute">No candidates match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
