"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, UserX, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { OptionPills } from "@/components/ui/option-pills"
import { cn } from "@/lib/utils/cn"
import {
  RATING_SPECS,
  POSITIONS,
  PAY_RATES,
  PAY_RATE_NOTE,
  DEFAULT_PAY_RATE,
  overallScore,
  gradeFor,
  needsComment,
  type RatingKey,
  type Ratings,
  type Recommendation,
} from "@/lib/onboarding/domain"
import { submitScorecardAction, noShowAction } from "./actions"

export interface InterviewFormProps {
  interviewId: string
  candidate: { firstName: string; lastName: string; email: string; phone: string; position: string }
  office: string
  offices: { code: string; name: string }[]
  interviewers: { id: string; name: string }[]
  defaultInterviewerId: string
  officeDefaults: Record<string, string | null>
}

const inputCls =
  "w-full bg-[#0E1C2A] border border-line rounded-md px-3 py-2 text-[14px] text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"
const labelCls = "block text-[11px] uppercase tracking-[0.1em] text-ink-mute mb-1"
const US_STATES = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ")

type YN = "" | "yes" | "no"

export function InterviewForm(p: InterviewFormProps) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const [office, setOffice] = useState(p.office)
  const [interviewer, setInterviewer] = useState(p.defaultInterviewerId)
  const [firstName, setFirstName] = useState(p.candidate.firstName)
  const [lastName, setLastName] = useState(p.candidate.lastName)
  const [email, setEmail] = useState(p.candidate.email)
  const [phone, setPhone] = useState(p.candidate.phone)
  const [position, setPosition] = useState(
    (POSITIONS as readonly string[]).includes(p.candidate.position) ? p.candidate.position : POSITIONS[0],
  )
  const [interviewType, setInterviewType] = useState<"in_person" | "phone">("in_person")
  const [ratings, setRatings] = useState<Partial<Ratings>>({})
  const [hasLicense, setHasLicense] = useState<YN>("")
  const [licenseState, setLicenseState] = useState("GA")
  const [transport, setTransport] = useState<YN>("")
  const [earliestStart, setEarliestStart] = useState("")
  const [availability, setAvailability] = useState("")
  const [payExpectation, setPayExpectation] = useState("")
  const [heardAbout, setHeardAbout] = useState("")
  const [previouslyEmployed, setPreviouslyEmployed] = useState<YN>("")
  const [redFlags, setRedFlags] = useState("")
  const [comments, setComments] = useState("")
  const [recommendation, setRecommendation] = useState<Recommendation | "">("")
  const [payRate, setPayRate] = useState<number>(DEFAULT_PAY_RATE)

  const allRated = RATING_SPECS.every((r) => ratings[r.key])
  const score = allRated ? overallScore(ratings as Ratings) : null
  const grade = score !== null ? gradeFor(score) : null
  const commentRequired = allRated && needsComment(ratings as Ratings)
  const licenseWarning = hasLicense === "no" || (hasLicense === "yes" && licenseState !== "GA")

  const missing = useMemo(() => {
    const m: string[] = []
    if (!office) m.push("office")
    if (!firstName.trim() || !lastName.trim()) m.push("candidate name")
    if (!email.trim()) m.push("email")
    if (phone.replace(/\D/g, "").length < 10) m.push("phone")
    if (!allRated) m.push("all six ratings")
    if (!hasLicense) m.push("driver's license")
    if (!transport) m.push("transportation")
    if (!previouslyEmployed) m.push("previously employed")
    if (commentRequired && !comments.trim()) m.push("comments (a rating is 2 or lower)")
    if (!recommendation) m.push("recommendation")
    return m
  }, [office, firstName, lastName, email, phone, allRated, hasLicense, transport, previouslyEmployed, commentRequired, comments, recommendation])

  function onOfficeChange(code: string) {
    // Follow the office default only if the interviewer was the old default.
    if (interviewer === p.officeDefaults[office] && p.officeDefaults[code]) setInterviewer(p.officeDefaults[code]!)
    setOffice(code)
  }

  function submit() {
    setError(null)
    if (missing.length) {
      setError(`Still needed: ${missing.join(", ")}.`)
      return
    }
    start(async () => {
      const r = await submitScorecardAction({
        interviewId: p.interviewId,
        officeCode: office,
        interviewerStaffId: interviewer,
        firstName,
        lastName,
        email,
        phone,
        position,
        interviewType,
        ratings,
        hasLicense: hasLicense === "yes",
        licenseState: hasLicense === "yes" ? licenseState : null,
        reliableTransport: transport === "yes",
        earliestStart: earliestStart || null,
        availability,
        payExpectation,
        heardAbout,
        previouslyEmployed: previouslyEmployed === "yes",
        redFlags,
        comments,
        recommendation,
        payRate: recommendation === "hire" ? payRate : null,
      })
      if (!r.ok) setError(r.error)
      else {
        setDone(
          recommendation === "hire"
            ? "Saved. The candidate gets the congratulations email with their document upload link."
            : recommendation === "no_hire"
              ? "Saved. A polite rejection email goes out in 24 hours unless the status changes first."
              : "Saved. The candidate gets an email with the link to book a follow-up interview.",
        )
        router.refresh()
      }
    })
  }

  // Two taps instead of a browser confirm() dialog (dialogs block automation
  // and look out of place on phones).
  const [armNoShow, setArmNoShow] = useState(false)
  function noShow() {
    if (!armNoShow) {
      setArmNoShow(true)
      setTimeout(() => setArmNoShow(false), 5000)
      return
    }
    setArmNoShow(false)
    setError(null)
    start(async () => {
      const r = await noShowAction(p.interviewId)
      if (!r.ok) setError(r.error)
      else router.refresh()
    })
  }

  if (done) {
    return (
      <div className="border border-grass/30 bg-grass/10 rounded-lg px-4 py-4 flex gap-3">
        <CheckCircle2 className="w-5 h-5 text-grass shrink-0 mt-0.5" />
        <div className="text-[14px] text-ink">{done}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5 pb-24">
      {/* No Show: prominent, needs nothing else */}
      <button
        type="button"
        onClick={noShow}
        disabled={pending}
        className="flex items-center justify-center gap-2 h-11 rounded-lg border border-coral/40 bg-coral/10 text-coral font-medium hover:bg-coral/20 disabled:opacity-50"
      >
        <UserX className="w-4 h-4" />
        {armNoShow ? "Tap again to confirm No Show (no email is sent)" : "Candidate didn't show — mark No Show"}
      </button>

      <Section title="Interview">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Office">
            <select className={inputCls} value={office} onChange={(e) => onOfficeChange(e.target.value)}>
              <option value="">Pick an office</option>
              {p.offices.map((o) => (
                <option key={o.code} value={o.code}>{o.code} — {o.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Interviewer">
            <select className={inputCls} value={interviewer} onChange={(e) => setInterviewer(e.target.value)}>
              {p.interviewers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Position">
            <select className={inputCls} value={position} onChange={(e) => setPosition(e.target.value)}>
              {POSITIONS.map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Field label="Interview type">
            <OptionPills
              value={interviewType}
              onChange={(v) => setInterviewType(v as "in_person" | "phone")}
              options={[{ value: "in_person", label: "In person" }, { value: "phone", label: "Phone" }]}
            />
          </Field>
        </div>
      </Section>

      <Section title="Candidate">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="First name"><input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} /></Field>
          <Field label="Last name"><input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} /></Field>
          <Field label="Email (required)"><input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Phone (required)"><input className={inputCls} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        </div>
      </Section>

      <Section title="Ratings" right={score !== null ? <ScoreBadge score={score} grade={grade!} /> : <span className="text-[12px] text-ink-mute">1 = poor · 5 = excellent</span>}>
        <div className="flex flex-col gap-4">
          {RATING_SPECS.map((spec) => (
            <RatingRow
              key={spec.key}
              label={spec.label}
              help={spec.help}
              anchors={spec.anchors}
              value={ratings[spec.key]}
              onChange={(v) => setRatings((r) => ({ ...r, [spec.key as RatingKey]: v }))}
            />
          ))}
        </div>
      </Section>

      <Section title="Details">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Valid driver's license">
            <div className="flex items-center gap-2 flex-wrap">
              <YesNo value={hasLicense} onChange={setHasLicense} />
              {hasLicense === "yes" && (
                <select className={cn(inputCls, "w-24")} value={licenseState} onChange={(e) => setLicenseState(e.target.value)} aria-label="License state">
                  {US_STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              )}
            </div>
            {licenseWarning && (
              <div className="mt-2 flex gap-2 text-[12px] text-sun">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {hasLicense === "no"
                  ? "No license: this hire can't drive a company vehicle."
                  : "Not a Georgia license: this hire can't drive a company vehicle (GA license required)."}
              </div>
            )}
          </Field>
          <Field label="Reliable transportation to the branch"><YesNo value={transport} onChange={setTransport} /></Field>
          <Field label="Earliest start date"><input className={inputCls} type="date" value={earliestStart} onChange={(e) => setEarliestStart(e.target.value)} /></Field>
          <Field label="Previously employed here"><YesNo value={previouslyEmployed} onChange={setPreviouslyEmployed} /></Field>
          <Field label="Availability (Saturdays / summer hours)"><input className={inputCls} value={availability} onChange={(e) => setAvailability(e.target.value)} /></Field>
          <Field label="Pay expectation"><input className={inputCls} value={payExpectation} onChange={(e) => setPayExpectation(e.target.value)} /></Field>
          <Field label="How they heard about us"><input className={inputCls} value={heardAbout} onChange={(e) => setHeardAbout(e.target.value)} /></Field>
        </div>
        <div className="grid gap-4 mt-4">
          <Field label="Red flags"><textarea className={inputCls} rows={2} value={redFlags} onChange={(e) => setRedFlags(e.target.value)} /></Field>
          <Field label={commentRequired ? "Other comments (required: a rating is 2 or lower)" : "Other comments"}>
            <textarea
              className={cn(inputCls, commentRequired && !comments.trim() && "border-coral/60")}
              rows={3}
              value={comments}
              onChange={(e) => setComments(e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section title="Recommendation">
        <OptionPills
          value={recommendation}
          onChange={(v) => setRecommendation(v as Recommendation)}
          options={[
            { value: "hire", label: "Hire" },
            { value: "no_hire", label: "No Hire" },
            { value: "follow_up", label: "Follow-up Interview" },
          ]}
        />
        {recommendation === "hire" && (
          <div className="mt-4 max-w-xs">
            <Field label="Pay rate">
              <select className={inputCls} value={payRate} onChange={(e) => setPayRate(Number(e.target.value))}>
                {PAY_RATES.map((r) => (
                  <option key={r} value={r}>${r}/hr</option>
                ))}
              </select>
            </Field>
            <p className="text-[12px] text-ink-mute mt-1.5">{PAY_RATE_NOTE}</p>
          </div>
        )}
      </Section>

      <div className="fixed bottom-0 inset-x-0 z-10 border-t border-line-soft bg-bg/95 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 sm:px-7 py-3 flex items-center gap-3">
          <div className="text-[12px] min-w-0 flex-1">
            {error ? (
              <span className="text-coral">{error}</span>
            ) : missing.length ? (
              <span className="text-ink-mute truncate block">Still needed: {missing.join(", ")}</span>
            ) : (
              <span className="text-grass">Ready to submit</span>
            )}
          </div>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Submit scorecard"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-bg-elev border border-line rounded-lg">
      <div className="px-4 sm:px-5 py-3 border-b border-line-soft flex items-center gap-3">
        <h2 className="font-display text-[15px]">{title}</h2>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  )
}

function YesNo({ value, onChange }: { value: YN; onChange: (v: YN) => void }) {
  return (
    <OptionPills
      value={value}
      onChange={(v) => onChange(v as YN)}
      options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
    />
  )
}

function RatingRow(props: {
  label: string
  help?: string
  anchors: [string, string, string]
  value: number | undefined
  onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="text-[14px] text-ink">{props.label}</div>
      {props.help && <div className="text-[12px] text-ink-mute mt-0.5">{props.help}</div>}
      <div className="grid grid-cols-5 gap-1.5 mt-2 max-w-md">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => props.onChange(n)}
            className={cn(
              "h-10 rounded-md border text-[14px] font-medium transition-colors",
              props.value === n
                ? n <= 2
                  ? "bg-coral/20 border-coral/50 text-coral"
                  : "bg-cyan/15 border-cyan/50 text-cyan"
                : "border-line text-ink-dim hover:border-cyan/40",
            )}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 max-w-md mt-1 text-[11px] text-ink-mute">
        <span>1 · {props.anchors[0]}</span>
        <span className="text-center">3 · {props.anchors[1]}</span>
        <span className="text-right">5 · {props.anchors[2]}</span>
      </div>
    </div>
  )
}

function ScoreBadge({ score, grade }: { score: number; grade: string }) {
  const tone = grade === "A" || grade === "B" ? "text-grass" : grade === "C" ? "text-sun" : "text-coral"
  return (
    <span className="text-[13px] text-ink-dim">
      Overall <span className="text-ink font-medium">{score.toFixed(1)}</span> · Grade <span className={cn("font-semibold", tone)}>{grade}</span>
    </span>
  )
}
