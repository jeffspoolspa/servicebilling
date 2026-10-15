import "server-only"
import { htmlToPdf } from "@/lib/external/pdf/render"
import {
  RATING_SPECS,
  RECOMMENDATION_LABEL,
  PAY_RATE_NOTE,
  formatPhone,
  type RatingKey,
} from "@/lib/onboarding/domain"
import type { CandidateRow, ScorecardRow } from "./db"
import { escapeHtml } from "./settings"
import { easternTime } from "./internal-emails"

const COL: Record<RatingKey, keyof ScorecardRow> = {
  professionalism: "r_professionalism",
  presentation: "r_presentation",
  communication: "r_communication",
  interest: "r_interest",
  experience: "r_experience",
  essential_functions: "r_essential_functions",
}

export function scorecardHtml(
  c: CandidateRow,
  sc: ScorecardRow,
  ctx: { interviewer: string; interviewAt: string | null; officeName: string },
): string {
  const e = (v: unknown) => escapeHtml(v === null || v === undefined || v === "" ? "—" : String(v))
  const yn = (b: boolean) => (b ? "Yes" : "No")
  const ratings = RATING_SPECS.map(
    (r) =>
      `<tr><td>${e(r.label)}</td><td class="n">${e(sc[COL[r.key]])} / 5</td></tr>`,
  ).join("")
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:12px/1.45 -apple-system,Helvetica,Arial,sans-serif;color:#111;margin:36px}
    h1{font-size:20px;margin:0 0 2px} .sub{color:#555;margin-bottom:18px}
    h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#0e7490;margin:18px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}
    table{border-collapse:collapse;width:100%} td{padding:3px 6px;vertical-align:top} td:first-child{color:#555;width:38%}
    .n{font-weight:600} .big{font-size:28px;font-weight:700} .box{display:inline-block;border:1px solid #ccc;border-radius:6px;padding:8px 14px;margin-right:10px}
    .pre{white-space:pre-wrap}
  </style></head><body>
    <h1>Interview Scorecard — ${e(c.first_name)} ${e(c.last_name)}</h1>
    <div class="sub">${e(ctx.officeName)} (${e(sc.office_code)}) · ${e(sc.position)} · ${e(sc.interview_type === "phone" ? "Phone" : "In person")} ·
      ${e(ctx.interviewAt ? easternTime(ctx.interviewAt) : "")} · Interviewer: ${e(ctx.interviewer)}</div>
    <div>
      <span class="box"><div>Overall</div><div class="big">${e(Number(sc.overall_score).toFixed(1))}</div></span>
      <span class="box"><div>Grade</div><div class="big">${e(sc.grade)}</div></span>
      <span class="box"><div>Recommendation</div><div class="big" style="font-size:18px">${e(RECOMMENDATION_LABEL[sc.recommendation])}</div></span>
      ${sc.recommendation === "hire" ? `<span class="box"><div>Training wage</div><div class="big" style="font-size:18px">$${e(sc.pay_rate)}/hr</div></span>` : ""}
    </div>
    ${sc.recommendation === "hire" ? `<p style="color:#555">${e(PAY_RATE_NOTE)}</p>` : ""}
    <h2>Candidate</h2>
    <table>
      <tr><td>Email</td><td>${e(c.email)}</td></tr>
      <tr><td>Phone</td><td>${e(formatPhone(c.phone))}</td></tr>
    </table>
    <h2>Ratings</h2><table>${ratings}</table>
    <h2>Details</h2>
    <table>
      <tr><td>Valid driver's license</td><td>${e(yn(sc.has_license))}${sc.has_license ? ` (${e(sc.license_state)})` : ""}</td></tr>
      <tr><td>Reliable transportation to the branch</td><td>${e(yn(sc.reliable_transport))}</td></tr>
      <tr><td>Earliest start date</td><td>${e(sc.earliest_start)}</td></tr>
      <tr><td>Availability (Saturdays / summer hours)</td><td class="pre">${e(sc.availability)}</td></tr>
      <tr><td>Pay expectation</td><td>${e(sc.pay_expectation)}</td></tr>
      <tr><td>How they heard about us</td><td>${e(sc.heard_about)}</td></tr>
      <tr><td>Previously employed here</td><td>${e(yn(sc.previously_employed))}</td></tr>
      <tr><td>Red flags</td><td class="pre">${e(sc.red_flags)}</td></tr>
      <tr><td>Other comments</td><td class="pre">${e(sc.comments)}</td></tr>
    </table>
    <p style="color:#888;margin-top:24px">Submitted ${e(easternTime(sc.created_at))} by ${e(sc.submitted_by)}.</p>
  </body></html>`
}

export async function scorecardPdf(...args: Parameters<typeof scorecardHtml>): Promise<Buffer> {
  return htmlToPdf(scorecardHtml(...args))
}
