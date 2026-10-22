import Link from "next/link"
import { notFound } from "next/navigation"
import { requireOnboardingStaff } from "@/lib/onboarding/infrastructure/staff-guard"
import { onboardingDb, type CandidateRow, type ScorecardRow, type InterviewRow } from "@/lib/onboarding/infrastructure/db"
import { loadRefData, officeName } from "@/lib/onboarding/application/context"
import { STATUS_LABEL, RECOMMENDATION_LABEL, DRIVER_CRITERIA, ageOn, formatPhone } from "@/lib/onboarding/domain"
import { easternTime } from "@/lib/onboarding/infrastructure/internal-emails"
import { ReviewActions, GustoPanel, AddDocuments, DetailsEditor } from "./review-actions"

export const dynamic = "force-dynamic"

type Cand = CandidateRow & {
  target_start_date: string | null
  marsh_draft_id: string | null
  gusto_invited_at: string | null
  gusto_invited_by: string | null
}

/** /service/onboarding/candidates/<id>/review — documents, scorecard, checklist, decision. */
export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireOnboardingStaff()
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const db = onboardingDb()
  const ref = await loadRefData(db)
  const { data: cRow } = await db.from("candidates").select("*").eq("id", id).maybeSingle()
  if (!cRow) notFound()
  const c = cRow as Cand
  const [{ data: det }, { data: docs }, { data: scs }, { data: ivs }, { data: events }, { data: apps }] = await Promise.all([
    db.from("candidate_details").select("*").eq("candidate_id", id).maybeSingle(),
    db.from("documents").select("*").eq("candidate_id", id).order("uploaded_at"),
    db.from("scorecards").select("*").eq("candidate_id", id).order("created_at", { ascending: false }),
    db.from("interviews").select("*").eq("candidate_id", id).order("start_at", { ascending: false }),
    db.from("events").select("created_at, type, status, actor, error").eq("candidate_id", id).order("created_at", { ascending: false }).limit(60),
    db.from("approvals").select("*").eq("candidate_id", id).order("created_at", { ascending: false }),
  ])
  const details = det as null | { legal_first: string; legal_last: string; dob: string; dl_number: string; dl_state: string; dl_expires: string; first_licensed_year: number | null; licensed_3_years: boolean | null }
  const documents = (docs ?? []) as { id: string; doc_type: string; filename: string; review_status: string; source: string; uploaded_at: string }[]
  const sc = ((scs ?? []) as ScorecardRow[])[0] ?? null
  const iv = ((ivs ?? []) as InterviewRow[])[0] ?? null
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })
  const age = details ? ageOn(details.dob, today) : null
  const licensed3 = details ? (details.licensed_3_years ?? (details.first_licensed_year !== null ? Number(today.slice(0, 4)) - details.first_licensed_year >= 3 : null)) : null
  const reviewable = c.status === "docs_submitted" || c.status === "reupload_requested"
  const fmt = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`
  const liveDocs = documents.filter((d) => d.review_status !== "superseded")

  return (
    <div className="flex flex-col gap-5 pb-10">
      <div>
        <Link href="/service/onboarding/candidates" className="text-[12px] text-ink-mute hover:text-ink">All candidates</Link>
        <h1 className="text-2xl sm:text-3xl font-display tracking-tight mt-1">
          {c.first_name} {c.last_name}
          {c.is_test && <span className="ml-2 align-middle text-[11px] px-2 py-0.5 rounded-full bg-sun/15 text-sun border border-sun/30">TEST</span>}
        </h1>
        <div className="text-ink-dim text-[13px]">
          {c.office_code} · {officeName(ref, c.office_code)} · {c.position} · <strong className="text-ink">{STATUS_LABEL[c.status]}</strong>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <Box title="Candidate">
          <Rows
            rows={[
              ["Email", c.email],
              ["Phone", formatPhone(c.phone)],
              ["Interview", iv ? `${easternTime(iv.start_at)} · ${ref.staff.find((s) => s.id === iv.interviewer_staff_id)?.name ?? "—"}` : "—"],
              ["Score", sc ? `${Number(sc.overall_score).toFixed(1)} · grade ${sc.grade} · ${RECOMMENDATION_LABEL[sc.recommendation]}` : "—"],
              ["Pay rate (scorecard)", c.pay_rate ? `$${c.pay_rate}/hr` : "—"],
              ["Summary notes", c.summary_notes ?? "—"],
              ["Red flags", sc?.red_flags ?? "—"],
            ]}
          />
        </Box>
        <Box title="License details (from the candidate)">
          {details ? (
            <Rows
              rows={[
                ["Legal name", `${details.legal_first} ${details.legal_last}`],
                ["Date of birth", `${fmt(details.dob)} (age ${age})`],
                ["License", `${details.dl_state} · ${details.dl_number}`],
                ["Expires", fmt(details.dl_expires)],
                ["Licensed 3+ years", licensed3 === null ? "—" : licensed3 ? "Yes (candidate says; confirm on the MVR)" : "No"],
              ]}
            />
          ) : (
            <p className="text-ink-mute text-[13px]">Not submitted yet.</p>
          )}
          {age !== null && age < 21 && <p className="mt-2 text-coral text-[13px]">Under 21: not an acceptable driver.</p>}
          {licensed3 === false && <p className="mt-1 text-coral text-[13px]">Candidate says licensed under 3 years: not an acceptable driver.</p>}
          {age !== null && age > 65 && <p className="mt-1 text-sun text-[13px]">Over 65: needs a physician statement.</p>}
          <DetailsEditor
            candidateId={c.id}
            initial={
              details && {
                legalFirst: details.legal_first,
                legalLast: details.legal_last,
                dob: details.dob,
                dlNumber: details.dl_number,
                dlExpires: details.dl_expires,
                licensed3Years: Boolean(licensed3),
              }
            }
          />
        </Box>
      </div>

      <Box title="Documents">
        {liveDocs.length === 0 ? (
          <p className="text-ink-mute text-[13px]">No documents yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {liveDocs.map((d) => (
              <div key={d.id}>
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="font-medium">{d.doc_type}</span>
                  <span className="text-ink-mute">{d.filename}</span>
                  {d.review_status === "reupload_requested" && <span className="text-sun text-[11px]">re-upload requested</span>}
                  {d.source === "staff" && <span className="text-ink-mute text-[11px]">staff</span>}
                  <a href={`/api/onboarding/documents/${d.id}`} target="_blank" rel="noreferrer" className="ml-auto text-cyan text-[12px] hover:underline">
                    Open
                  </a>
                </div>
                {d.doc_type !== "Interview Scorecard" && (
                  <iframe src={`/api/onboarding/documents/${d.id}`} className="mt-2 w-full h-[520px] rounded-md border border-line bg-white" title={d.filename} />
                )}
              </div>
            ))}
          </div>
        )}
        <AddDocuments candidateId={c.id} />
      </Box>

      <Box title="Unacceptable driver criteria (carrier sheet 5-R-361 + company rules)">
        {DRIVER_CRITERIA.map((g) => (
          <div key={g.heading} className="mb-2">
            <div className="text-[13px] font-medium">{g.heading}</div>
            <ul className="list-disc pl-5 text-[12px] text-ink-dim">
              {g.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        ))}
      </Box>

      {reviewable && me.staff.can_approve && (
        <ReviewActions candidateId={c.id} checklist={ref.settings.approvalChecklist} defaultPayRate={Number(c.pay_rate ?? 14)} />
      )}

      {(c.status === "approved" || c.status === "gusto_invited") && (
        <GustoPanel
          candidateId={c.id}
          invited={c.status === "gusto_invited"}
          invitedBy={c.gusto_invited_by}
          marshDraft={Boolean(c.marsh_draft_id)}
          values={[
            ["First name", details?.legal_first ?? c.first_name],
            ["Last name", details?.legal_last ?? c.last_name],
            ["Personal email", c.email],
            ["Start date", c.target_start_date ? fmt(c.target_start_date) : "—"],
            ["Work location", `${officeName(ref, c.office_code)}${ref.offices.find((o) => o.code === c.office_code)?.address ? ` (${ref.offices.find((o) => o.code === c.office_code)?.address})` : ""}`],
            ["Department", ref.offices.find((o) => o.code === c.office_code)?.gusto_department ?? `${c.office_code} Maintenance`],
            ["Job title", "Maintenance Trainee"],
            ["Hourly rate", c.pay_rate ? `$${Number(c.pay_rate).toFixed(2)}` : "—"],
          ]}
        />
      )}

      <div className="grid lg:grid-cols-2 gap-5">
        <Box title="Decisions">
          {(apps ?? []).length === 0 ? (
            <p className="text-ink-mute text-[13px]">None yet.</p>
          ) : (
            <ul className="text-[13px] flex flex-col gap-1">
              {(apps as { id: string; decision: string; approver: string; created_at: string; notes: string | null; target_start_date: string | null }[]).map((a) => (
                <li key={a.id}>
                  <span className="font-medium capitalize">{a.decision}</span> · {a.approver} · {easternTime(a.created_at)}
                  {a.target_start_date ? ` · start ${fmt(a.target_start_date)}` : ""}
                  {a.notes ? <div className="text-ink-dim">{a.notes}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </Box>
        <Box title="Timeline">
          <ul className="text-[12px] font-mono flex flex-col gap-0.5 max-h-72 overflow-y-auto">
            {((events ?? []) as { created_at: string; type: string; status: string; actor: string | null; error: string | null }[]).map((e, i) => (
              <li key={i} className={e.status === "error" ? "text-coral" : "text-ink-dim"}>
                {new Date(e.created_at).toLocaleString("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })} {e.type}
                {e.actor ? ` · ${e.actor}` : ""}
                {e.error ? ` — ${e.error.slice(0, 140)}` : ""}
              </li>
            ))}
          </ul>
        </Box>
      </div>
    </div>
  )
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-bg-elev border border-line rounded-lg">
      <div className="px-4 py-3 border-b border-line-soft font-display text-[15px]">{title}</div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <table className="text-[13px]">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="pr-4 py-0.5 text-ink-mute align-top whitespace-nowrap">{k}</td>
            <td className="py-0.5">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
