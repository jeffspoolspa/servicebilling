"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { OptionPills } from "@/components/ui/option-pills"
import { createSupabaseBrowser } from "@/lib/supabase/client"
import { PAY_RATES, PAY_RATE_NOTE, STAFF_DOC_TYPES, UPLOAD_DOC_TYPES, type StaffDocType } from "@/lib/onboarding/domain"
import { prepare, type Picked } from "@/lib/onboarding/infrastructure/compress-photo"
import {
  approveAction,
  approveDocumentsAction,
  secondInterviewAction,
  rejectAction,
  reuploadAction,
  gustoInvitedAction,
  retryMarshAction,
  staffTargetsAction,
  staffFileAction,
  staffDetailsAction,
  type ReviewResult,
} from "./actions"

const inputCls =
  "w-full bg-[#0E1C2A] border border-line rounded-md px-3 py-2 text-[14px] text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none"
const labelCls = "block text-[11px] uppercase tracking-[0.1em] text-ink-mute mb-1"

function useRun() {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [result, setResult] = useState<ReviewResult | null>(null)
  const run = (fn: () => Promise<ReviewResult>) =>
    start(async () => {
      setResult(null)
      const r = await fn()
      setResult(r)
      if (r.ok) router.refresh()
    })
  return { pending, result, run }
}

function Result({ r }: { r: ReviewResult | null }) {
  if (!r) return null
  return <p className={`text-[13px] ${r.ok ? "text-grass" : "text-coral"}`}>{r.ok ? r.message : r.error}</p>
}

export function ReviewActions({
  candidateId,
  checklist,
  defaultPayRate,
  followUp,
}: {
  candidateId: string
  checklist: { key: string; label: string }[]
  defaultPayRate: number
  /** Follow-up path: approving clears the documents only (no start, pay or Marsh). */
  followUp: boolean
}) {
  const { pending, result, run } = useRun()
  const [mode, setMode] = useState<"approve" | "reject" | "reupload">("approve")
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  const [criminalFound, setCriminalFound] = useState<"" | "yes" | "no">("")
  const [criminalNote, setCriminalNote] = useState("")
  const [start, setStart] = useState("")
  const [payRate, setPayRate] = useState((PAY_RATES as readonly number[]).includes(defaultPayRate) ? defaultPayRate : 14)
  const [notes, setNotes] = useState("")
  const [reason, setReason] = useState("")
  const [docs, setDocs] = useState<string[]>([])
  const [ruNote, setRuNote] = useState("")

  const allChecked = checklist.every((i) => checks[i.key]) && criminalFound !== "" && (criminalFound === "no" || criminalNote.trim())

  return (
    <section className="bg-bg-elev border border-cyan/30 rounded-lg">
      <div className="px-4 py-3 border-b border-line-soft flex items-center gap-3">
        <h2 className="font-display text-[15px]">Decision</h2>
        <div className="ml-auto">
          <OptionPills
            value={mode}
            onChange={(v) => setMode(v as typeof mode)}
            options={[
              { value: "approve", label: followUp ? "Approve documents" : "Approve" },
              { value: "reupload", label: "Request re-upload" },
              { value: "reject", label: "Reject" },
            ]}
            size="sm"
          />
        </div>
      </div>
      <div className="p-4 flex flex-col gap-4">
        {mode === "approve" && (
          <>
            <div className="flex flex-col gap-2">
              {checklist.map((i) => (
                <label key={i.key} className="flex gap-2 text-[14px] items-start">
                  <input type="checkbox" className="mt-1" checked={Boolean(checks[i.key])} onChange={(e) => setChecks((c) => ({ ...c, [i.key]: e.target.checked }))} />
                  <span>{i.label}</span>
                </label>
              ))}
            </div>
            <div>
              <span className={labelCls}>Anything found on the criminal history report?</span>
              <OptionPills
                value={criminalFound}
                onChange={(v) => setCriminalFound(v as "yes" | "no")}
                options={[{ value: "no", label: "Nothing found" }, { value: "yes", label: "Something found" }]}
              />
              {criminalFound === "yes" && (
                <textarea className={`${inputCls} mt-2`} rows={2} placeholder="Required: what was found and why it's acceptable" value={criminalNote} onChange={(e) => setCriminalNote(e.target.value)} />
              )}
            </div>
            {!followUp && (
              <>
              <div className="grid sm:grid-cols-2 gap-3 max-w-lg">
                <div>
                  <span className={labelCls}>Target start date</span>
                  <input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} />
                </div>
                <div>
                  <span className={labelCls}>Pay rate</span>
                  <select className={inputCls} value={payRate} onChange={(e) => setPayRate(Number(e.target.value))}>
                    {PAY_RATES.map((r) => (
                      <option key={r} value={r}>${r}/hr</option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-[12px] text-ink-mute -mt-2">{PAY_RATE_NOTE}</p>
              </>
            )}
            <div>
              <span className={labelCls}>Notes (optional)</span>
              <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                disabled={pending || !allChecked || (!followUp && !start)}
                onClick={() =>
                  run(() =>
                    followUp
                      ? approveDocumentsAction({ candidateId, checklist: checks, criminalFound: criminalFound === "yes", criminalNote: criminalNote || null, notes: notes || null })
                      : approveAction({
                      candidateId,
                      checklist: checks,
                      criminalFound: criminalFound === "yes",
                      criminalNote: criminalNote || null,
                      targetStartDate: start,
                      payRate,
                      notes: notes || null,
                    }),
                  )
                }
              >
                {pending ? "Approving…" : followUp ? "Approve documents" : "Approve"}
              </Button>
              {!allChecked && <span className="text-[12px] text-ink-mute">Tick every item and answer the criminal history question.</span>}
            </div>
          </>
        )}

        {mode === "reupload" && (
          <>
            <div className="flex flex-col gap-2">
              {UPLOAD_DOC_TYPES.map((d) => (
                <label key={d} className="flex gap-2 text-[14px]">
                  <input type="checkbox" checked={docs.includes(d)} onChange={(e) => setDocs((cur) => (e.target.checked ? [...cur, d] : cur.filter((x) => x !== d)))} />
                  {d}
                </label>
              ))}
            </div>
            <div>
              <span className={labelCls}>Note to the candidate</span>
              <textarea className={inputCls} rows={2} placeholder="e.g. The MVR is older than 30 days; please request a new one." value={ruNote} onChange={(e) => setRuNote(e.target.value)} />
            </div>
            <div>
              <Button disabled={pending || docs.length === 0} onClick={() => run(() => reuploadAction(candidateId, docs, ruNote))}>
                {pending ? "Sending…" : "Send new upload link"}
              </Button>
            </div>
          </>
        )}

        {mode === "reject" && (
          <>
            <div>
              <span className={labelCls}>Reason (internal, required)</span>
              <textarea className={inputCls} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <p className="text-[12px] text-ink-mute">The candidate gets the standard polite rejection email (not the reason).</p>
            <div>
              <Button disabled={pending || !reason.trim()} onClick={() => run(() => rejectAction(candidateId, reason))} className="border-coral/50 text-coral">
                {pending ? "Rejecting…" : "Reject candidate"}
              </Button>
            </div>
          </>
        )}
        <Result r={result} />
      </div>
    </section>
  )
}

export function GustoPanel({
  candidateId,
  invited,
  invitedBy,
  marshDraft,
  values,
}: {
  candidateId: string
  invited: boolean
  invitedBy: string | null
  marshDraft: boolean
  values: [string, string][]
}) {
  const { pending, result, run } = useRun()
  const [copied, setCopied] = useState<string | null>(null)
  const copy = async (k: string, v: string) => {
    try {
      await navigator.clipboard.writeText(v)
      setCopied(k)
      setTimeout(() => setCopied(null), 1200)
    } catch {
      /* clipboard blocked: select manually */
    }
  }
  return (
    <section className="bg-bg-elev border border-grass/30 rounded-lg">
      <div className="px-4 py-3 border-b border-line-soft flex items-center gap-3">
        <h2 className="font-display text-[15px]">Next steps after approval</h2>
      </div>
      <div className="p-4 flex flex-col gap-4">
        <div className="text-[13px]">
          <span className="font-medium">Marsh driver add: </span>
          {marshDraft ? (
            <span className="text-grass">draft is in jpsbilling&apos;s Gmail Drafts ("Driver add – …"). Review it and send.</span>
          ) : (
            <>
              <span className="text-coral">no draft yet. </span>
              <button className="text-cyan underline" disabled={pending} onClick={() => run(() => retryMarshAction(candidateId))}>
                Create draft
              </button>
            </>
          )}
        </div>
        <div>
          <div className="text-[13px] font-medium mb-2">
            Create in Gusto{" "}
            <a href="https://app.gusto.com/people" target="_blank" rel="noreferrer" className="ml-2 text-cyan font-normal hover:underline">
              Open Gusto People
            </a>
          </div>
          <table className="text-[13px]">
            <tbody>
              {values.map(([k, v]) => (
                <tr key={k}>
                  <td className="pr-4 py-1 text-ink-mute">{k}</td>
                  <td className="py-1 pr-3">{v}</td>
                  <td>
                    <button className="text-[11px] text-cyan hover:underline" onClick={() => copy(k, v)}>
                      {copied === k ? "Copied" : "Copy"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[12px] text-ink-mute mt-2">Turn on &quot;Invite this employee to enter their own info&quot; so they complete onboarding (I-9, W-4, direct deposit) themselves.</p>
        </div>
        {invited ? (
          <p className="text-[13px] text-grass">Gusto invite recorded{invitedBy ? ` by ${invitedBy}` : ""}.</p>
        ) : (
          <div>
            <Button variant="primary" disabled={pending} onClick={() => run(() => gustoInvitedAction(candidateId))}>
              {pending ? "Saving…" : "Mark invited in Gusto"}
            </Button>
          </div>
        )}
        <Result r={result} />
      </div>
    </section>
  )
}

/** Staff file a document the candidate sent some other way (photos become one PDF). */
export function AddDocuments({ candidateId }: { candidateId: string }) {
  const { pending, result, run } = useRun()
  const [docType, setDocType] = useState<StaffDocType>("MVR")
  const [files, setFiles] = useState<Picked[]>([])
  const [pickErr, setPickErr] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)

  async function add(list: FileList | null) {
    if (!list?.length) return
    setPickErr(null)
    try {
      const prepared: Picked[] = []
      for (const f of Array.from(list)) prepared.push(await prepare(f))
      setFiles((cur) => [...cur, ...prepared])
    } catch (e) {
      setPickErr(e instanceof Error ? e.message : "Couldn't add that file.")
    }
  }

  const file = () =>
    run(async (): Promise<ReviewResult> => {
      const t = await staffTargetsAction(candidateId, files.map((f) => ({ name: f.name, type: f.type, size: f.size })))
      if (!t.ok) return t
      const sb = createSupabaseBrowser()
      for (const [i, f] of files.entries()) {
        const { error } = await sb.storage.from("onboarding-uploads").uploadToSignedUrl(t.targets[i].path, t.targets[i].token, f.file, { contentType: f.type })
        if (error) return { ok: false, error: `${f.name} didn't upload. Try again.` }
      }
      const r = await staffFileAction({ candidateId, docType, files: files.map((f, i) => ({ path: t.targets[i].path, type: f.type, name: f.name })) })
      if (r.ok) setFiles([])
      return r
    })

  return (
    <div className="mt-4 pt-4 border-t border-line-soft flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={labelCls + " mb-0"}>Add documents</span>
        <OptionPills value={docType} onChange={(v) => setDocType(v as StaffDocType)} options={STAFF_DOC_TYPES.map((d) => ({ value: d, label: d }))} size="sm" />
      </div>
      {files.map((f) => (
        <div key={f.id} className="flex items-center gap-2 text-[13px]">
          <span className="truncate flex-1">{f.name}</span>
          <button className="text-[12px] text-ink-mute hover:text-ink" onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))}>
            Remove
          </button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button onClick={() => ref.current?.click()} disabled={pending}>
          {files.length ? "Add another page" : "Choose files"}
        </Button>
        <Button variant="primary" disabled={pending || files.length === 0} onClick={file}>
          {pending ? "Filing…" : `File as ${docType}`}
        </Button>
      </div>
      <input
        ref={ref}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          add(e.target.files)
          e.target.value = ""
        }}
      />
      {pickErr && <p className="text-[13px] text-coral">{pickErr}</p>}
      <Result r={result} />
    </div>
  )
}

export interface DetailsValues {
  legalFirst: string
  legalLast: string
  dob: string
  dlNumber: string
  dlExpires: string
  licensed3Years: boolean
}

/** Staff enter or correct the license details (GA only, same rules as the candidate form). */
export function DetailsEditor({ candidateId, initial }: { candidateId: string; initial: DetailsValues | null }) {
  const { pending, result, run } = useRun()
  const [open, setOpen] = useState(false)
  const [v, setV] = useState<DetailsValues>(initial ?? { legalFirst: "", legalLast: "", dob: "", dlNumber: "", dlExpires: "", licensed3Years: false })
  const set = (k: keyof DetailsValues) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV((cur) => ({ ...cur, [k]: k === "licensed3Years" ? e.target.checked : e.target.value }))

  if (!open)
    return (
      <div className="mt-2">
        <button className="text-[12px] text-cyan hover:underline" onClick={() => setOpen(true)}>
          {initial ? "Edit details" : "Enter details"}
        </button>
        <Result r={result} />
      </div>
    )
  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className={labelCls}>Legal first name</span>
          <input className={inputCls} value={v.legalFirst} onChange={set("legalFirst")} />
        </div>
        <div>
          <span className={labelCls}>Legal last name</span>
          <input className={inputCls} value={v.legalLast} onChange={set("legalLast")} />
        </div>
        <div>
          <span className={labelCls}>Date of birth</span>
          <input type="date" className={inputCls} value={v.dob} onChange={set("dob")} />
        </div>
        <div>
          <span className={labelCls}>GA license #</span>
          <input className={inputCls} inputMode="numeric" value={v.dlNumber} onChange={set("dlNumber")} />
        </div>
        <div>
          <span className={labelCls}>License expires</span>
          <input type="date" className={inputCls} value={v.dlExpires} onChange={set("dlExpires")} />
        </div>
      </div>
      <label className="flex gap-2 text-[14px] items-center">
        <input type="checkbox" checked={v.licensed3Years} onChange={set("licensed3Years")} />
        Licensed 3+ years
      </label>
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const r = await staffDetailsAction({ candidateId, ...v })
              if (r.ok) setOpen(false)
              return r
            })
          }
        >
          {pending ? "Saving…" : "Save details"}
        </Button>
        <button className="text-[12px] text-ink-mute hover:text-ink" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Result r={result} />
    </div>
  )
}

/** After the second interview: the approver's Hire / No Hire, each with a reason. */
export function SecondInterviewDecision({ candidateId }: { candidateId: string }) {
  const { pending, result, run } = useRun()
  const [decision, setDecision] = useState<"" | "hire" | "no_hire">("")
  const [reason, setReason] = useState("")
  return (
    <section className="bg-bg-elev border border-cyan/30 rounded-lg">
      <div className="px-4 py-3 border-b border-line-soft flex items-center gap-3">
        <h2 className="font-display text-[15px]">Second interview</h2>
        <div className="ml-auto">
          <OptionPills
            value={decision}
            onChange={(v) => setDecision(v as "hire" | "no_hire")}
            options={[{ value: "hire", label: "Hire" }, { value: "no_hire", label: "No Hire" }]}
            size="sm"
          />
        </div>
      </div>
      <div className="p-4 flex flex-col gap-3">
        <div>
          <span className={labelCls}>Reason (internal, required)</span>
          <textarea className={inputCls} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <p className="text-[12px] text-ink-mute">
          {decision === "no_hire" ? "The candidate gets the standard rejection email (not the reason)." : "Hire moves the candidate to Approve: start date, pay rate, Marsh draft."}
        </p>
        <div>
          <Button variant="primary" disabled={pending || !decision || !reason.trim()} onClick={() => run(() => secondInterviewAction(candidateId, decision, reason))}>
            {pending ? "Saving…" : decision === "no_hire" ? "Record No Hire" : "Record Hire"}
          </Button>
        </div>
        <Result r={result} />
      </div>
    </section>
  )
}
