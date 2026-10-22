import { redirect } from "next/navigation"
import Link from "next/link"
import { CalendarClock, ClipboardCheck, ChevronRight } from "lucide-react"
import { requireOnboardingStaff } from "@/lib/onboarding/infrastructure/staff-guard"
import { onboardingDb, type CandidateRow, type InterviewRow, type ScorecardRow, type StaffRow, type OfficeRow } from "@/lib/onboarding/infrastructure/db"
import { loadRefData, officeDefaultStaff } from "@/lib/onboarding/application/context"
import { STATUS_LABEL, RECOMMENDATION_LABEL, formatPhone } from "@/lib/onboarding/domain"
import { easternTime, nyStartOfToday } from "@/lib/onboarding/infrastructure/internal-emails"
import { InterviewForm, type InterviewFormProps } from "./interview-form"

export const dynamic = "force-dynamic"

/**
 * /service/onboarding/interview — the one universal interview page.
 *   ?i=<interview id>  (the link in the 15-minute email) -> that candidate's form
 *   no param           -> picker: today's + upcoming interviews, plus recent
 *                         ones still missing a scorecard
 */
export default async function InterviewPage({ searchParams }: { searchParams: Promise<{ i?: string }> }) {
  const me = await requireOnboardingStaff()
  const { i } = await searchParams
  const db = onboardingDb()

  if (i && /^[0-9a-f-]{36}$/i.test(i)) {
    const { data: iv } = await db.from("interviews").select("*").eq("id", i).maybeSingle()
    if (iv) return <ForInterview iv={iv as InterviewRow} meStaffId={me.staff.id} />
  }
  return <Picker />
}

async function ForInterview({ iv, meStaffId }: { iv: InterviewRow; meStaffId: string }) {
  const db = onboardingDb()
  const ref = await loadRefData(db)
  const { data: c } = await db.from("candidates").select("*").eq("id", iv.candidate_id).single()
  const candidate = c as CandidateRow
  const { data: scRows } = await db.from("scorecards").select("*").eq("interview_id", iv.id).limit(1)
  const sc = (scRows?.[0] ?? null) as ScorecardRow | null
  // A second interview has no scorecard: the approver decides on the candidate page.
  if (!sc && candidate.status === "second_interview") redirect(`/service/onboarding/candidates/${candidate.id}/review`)

  const header = (
    <div className="mb-5">
      <Link href="/service/onboarding/interview" className="text-[12px] text-ink-mute hover:text-ink">
        All interviews
      </Link>
      <h1 className="text-2xl sm:text-3xl font-display tracking-tight mt-1">
        {candidate.first_name} {candidate.last_name}
        {candidate.is_test && <span className="ml-2 align-middle text-[11px] px-2 py-0.5 rounded-full bg-sun/15 text-sun border border-sun/30">TEST</span>}
      </h1>
      <div className="text-ink-dim text-[13px]">
        {easternTime(iv.start_at)} · {iv.office_code ?? "office not set"} · {iv.event_name ?? "Calendly interview"}
      </div>
    </div>
  )

  if (sc) {
    const by = ref.staff.find((s) => s.id === sc.interviewer_staff_id)?.name ?? sc.submitted_by
    return (
      <>
        {header}
        <Notice tone="grass" title="Scorecard submitted">
          {by} scored {Number(sc.overall_score).toFixed(1)} (grade {sc.grade}), recommendation{" "}
          <strong>{RECOMMENDATION_LABEL[sc.recommendation]}</strong>. Candidate status: {STATUS_LABEL[candidate.status]}.
        </Notice>
      </>
    )
  }
  if (iv.status === "no_show") {
    return (
      <>
        {header}
        <Notice tone="coral" title="Marked No Show">Candidate status: {STATUS_LABEL[candidate.status]}.</Notice>
      </>
    )
  }
  if (iv.status === "canceled" || iv.status === "rescheduled") {
    return (
      <>
        {header}
        <Notice tone="sun" title={iv.status === "canceled" ? "This interview was canceled in Calendly" : "This interview is being rescheduled"}>
          Check the interview list for the new time.
        </Notice>
      </>
    )
  }

  const interviewers = ref.staff.filter((s) => s.active && s.can_interview)
  const defaultInterviewer =
    iv.interviewer_staff_id ?? officeDefaultStaff(ref, iv.office_code)?.id ?? meStaffId
  const props: InterviewFormProps = {
    interviewId: iv.id,
    candidate: {
      firstName: candidate.first_name,
      lastName: candidate.last_name,
      email: candidate.email,
      phone: formatPhone(candidate.phone),
      position: candidate.position,
    },
    office: iv.office_code ?? candidate.office_code ?? "",
    offices: ref.offices.map((o: OfficeRow) => ({ code: o.code, name: o.name })),
    interviewers: interviewers.map((s: StaffRow) => ({ id: s.id, name: s.name })),
    defaultInterviewerId: interviewers.some((s) => s.id === defaultInterviewer) ? defaultInterviewer : meStaffId,
    officeDefaults: Object.fromEntries(ref.offices.map((o) => [o.code, officeDefaultStaff(ref, o.code)?.id ?? null])),
  }
  return (
    <>
      {header}
      <InterviewForm {...props} />
    </>
  )
}

async function Picker() {
  const db = onboardingDb()
  const ref = await loadRefData(db)
  const startOfToday = nyStartOfToday()
  const since = new Date(Math.min(startOfToday.getTime(), Date.now() - 3 * 24 * 3600_000))
  const { data: ivs } = await db
    .from("interviews")
    .select("*, candidates(first_name, last_name, phone, is_test)")
    .eq("status", "scheduled")
    .gte("start_at", since.toISOString())
    .order("start_at")
    .limit(100)
  type Row = InterviewRow & { candidates: Pick<CandidateRow, "first_name" | "last_name" | "phone" | "is_test"> }
  const rows = (ivs ?? []) as Row[]
  const needsScore = rows.filter((r) => new Date(r.start_at) < startOfToday)
  const upcoming = rows.filter((r) => new Date(r.start_at) >= startOfToday)

  const List = ({ items, empty }: { items: Row[]; empty: string }) =>
    items.length === 0 ? (
      <div className="text-ink-mute text-[13px] px-4 py-6">{empty}</div>
    ) : (
      <ul className="divide-y divide-line-soft">
        {items.map((r) => (
          <li key={r.id}>
            <Link href={`/service/onboarding/interview?i=${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03]">
              <div className="w-14 text-[11px] font-mono text-cyan shrink-0">{r.office_code ?? "—"}</div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] text-ink truncate">
                  {r.candidates.first_name} {r.candidates.last_name}
                  {r.candidates.is_test && <span className="ml-2 text-[10px] text-sun">TEST</span>}
                </div>
                <div className="text-[12px] text-ink-mute">
                  {easternTime(r.start_at)} · {ref.staff.find((s) => s.id === r.interviewer_staff_id)?.name ?? "interviewer not set"}
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-ink-mute" />
            </Link>
          </li>
        ))}
      </ul>
    )

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-display tracking-tight">Interview Form</h1>
        <p className="text-ink-dim text-[13px]">Pick the candidate you're interviewing. The 15-minute email links straight to their form.</p>
      </div>
      {needsScore.length > 0 && (
        <section className="bg-bg-elev border border-coral/30 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-line-soft flex items-center gap-2 text-coral text-[12px] uppercase tracking-[0.1em]">
            <ClipboardCheck className="w-4 h-4" /> Missing a scorecard
          </div>
          <List items={needsScore} empty="" />
        </section>
      )}
      <section className="bg-bg-elev border border-line rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-line-soft flex items-center gap-2 text-ink-mute text-[12px] uppercase tracking-[0.1em]">
          <CalendarClock className="w-4 h-4" /> Today and upcoming
        </div>
        <List items={upcoming} empty="No interviews scheduled. New Calendly bookings show up here automatically." />
      </section>
    </div>
  )
}

function Notice({ tone, title, children }: { tone: "grass" | "coral" | "sun"; title: string; children: React.ReactNode }) {
  const cls = { grass: "border-grass/30 bg-grass/10", coral: "border-coral/30 bg-coral/10", sun: "border-sun/30 bg-sun/10" }[tone]
  return (
    <div className={`border rounded-lg px-4 py-3 ${cls}`}>
      <div className="font-medium text-ink">{title}</div>
      <div className="text-[13px] text-ink-dim mt-0.5">{children}</div>
    </div>
  )
}
