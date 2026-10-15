"use client"

import { useRef, useState } from "react"
import { createSupabaseBrowser } from "@/lib/supabase/client"
import { detailProblems, type UploadDocType, type UploadSlot } from "@/lib/onboarding/domain"
import { createTargetsAction, submitDocumentsAction } from "./actions"

const BUCKET = "onboarding-uploads"
const MAX_BYTES = 20 * 1024 * 1024

interface Props {
  token: string
  firstName: string
  purpose: "initial" | "reupload"
  docs: UploadDocType[]
  note: string | null
}

interface Picked {
  id: string
  name: string
  file: Blob
  type: string
  size: number
}

const input =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-[16px] text-slate-900 focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-100"
const label = "block text-[14px] font-medium text-slate-800 mb-1"

const US_STATES = "GA AL FL SC NC TN AK AZ AR CA CO CT DE HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY ND OH OK OR PA RI SD TX UT VT VA WA WV WI WY DC".split(" ")

/** Re-encode a photo as a compressed JPEG (max 2200 px). PDFs pass through. */
async function prepare(file: File): Promise<Picked> {
  const id = Math.random().toString(36).slice(2)
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    if (file.size > MAX_BYTES) throw new Error(`${file.name} is over 20 MB. Please upload a smaller file.`)
    return { id, name: file.name, file, type: "application/pdf", size: file.size }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error(`We couldn't read ${file.name}. Take a new photo, or upload a JPG or PDF.`))
      el.src = url
    })
    const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process the photo."))), "image/jpeg", 0.82),
    )
    return { id, name: file.name.replace(/\.[^.]+$/, "") + ".jpg", file: blob, type: "image/jpeg", size: blob.size }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function UploadForm(p: Props) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })
  const wants = (d: UploadDocType) => p.docs.includes(d)

  const [legalFirst, setLegalFirst] = useState("")
  const [legalLast, setLegalLast] = useState("")
  const [dob, setDob] = useState("")
  const [dlState, setDlState] = useState("GA")
  const [dlNumber, setDlNumber] = useState("")
  const [dlExpires, setDlExpires] = useState("")
  const [firstYear, setFirstYear] = useState("")
  const [files, setFiles] = useState<Record<UploadSlot, Picked[]>>({ mvr: [], dl_front: [], dl_back: [], criminal: [] })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const notGA = dlState !== "GA"

  async function add(slot: UploadSlot, list: FileList | null, single: boolean) {
    if (!list?.length) return
    setError(null)
    setBusy("Preparing photos…")
    try {
      const prepared: Picked[] = []
      for (const f of Array.from(list)) prepared.push(await prepare(f))
      setFiles((cur) => ({ ...cur, [slot]: single ? prepared.slice(0, 1) : [...cur[slot], ...prepared] }))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that file.")
    } finally {
      setBusy(null)
    }
  }

  async function submit() {
    setError(null)
    const details =
      p.purpose === "initial"
        ? { legalFirst, legalLast, dob, dlState, dlNumber, dlExpires, firstLicensedYear: Number(firstYear) }
        : null
    if (details) {
      const problems = detailProblems(details, today)
      if (problems.length) return setError(problems[0])
    }
    const needed: [UploadSlot, string][] = []
    if (wants("MVR")) needed.push(["mvr", "your 3-year MVR"])
    if (wants("Drivers License")) needed.push(["dl_front", "the front of your license"], ["dl_back", "the back of your license"])
    if (wants("Criminal History")) needed.push(["criminal", "your criminal history report"])
    const missing = needed.find(([s]) => files[s].length === 0)
    if (missing) return setError(`Please add ${missing[1]}.`)

    const all = (Object.keys(files) as UploadSlot[]).flatMap((slot) => files[slot].map((f) => ({ slot, f })))
    setBusy("Uploading…")
    try {
      const t = await createTargetsAction(
        p.token,
        all.map(({ slot, f }) => ({ slot, name: f.name, type: f.type, size: f.size })),
      )
      if (!t.ok) throw new Error(t.error)
      const sb = createSupabaseBrowser()
      for (let i = 0; i < all.length; i++) {
        setBusy(`Uploading ${i + 1} of ${all.length}…`)
        const target = t.targets[i]
        const { error: upErr } = await sb.storage.from(BUCKET).uploadToSignedUrl(target.path, target.token, all[i].f.file, {
          contentType: all[i].f.type,
        })
        if (upErr) throw new Error("An upload failed. Check your connection and try again.")
      }
      setBusy("Saving…")
      const r = await submitDocumentsAction(p.token, {
        details,
        files: all.map(({ slot, f }, i) => ({ slot, path: t.targets[i].path, type: f.type })),
      })
      if (!r.ok) throw new Error(r.error)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  if (done) {
    return (
      <div className="mt-4 bg-white rounded-xl border border-emerald-200 p-5">
        <h1 className="text-xl font-semibold text-emerald-800">Thank you, {p.firstName}!</h1>
        <p className="mt-2 text-slate-700">We received your documents. Our office will review them and contact you about next steps.</p>
      </div>
    )
  }

  return (
    <div className="mt-2 flex flex-col gap-4 pb-10">
      <div>
        <h1 className="text-2xl font-semibold leading-tight">
          {p.purpose === "reupload" ? "Please re-upload a document" : `Hi ${p.firstName}, one last step`}
        </h1>
        <p className="mt-1 text-slate-600">
          {p.purpose === "reupload"
            ? "We need a new copy of the document(s) below."
            : "Upload your hiring documents below. You can take photos with your phone's camera."}
        </p>
        {p.note && <p className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-slate-800">{p.note}</p>}
      </div>

      {p.purpose === "initial" && (
        <Card title="Your information">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={label}>Legal first name</span>
              <input className={input} value={legalFirst} onChange={(e) => setLegalFirst(e.target.value)} autoComplete="given-name" />
            </div>
            <div>
              <span className={label}>Legal last name</span>
              <input className={input} value={legalLast} onChange={(e) => setLegalLast(e.target.value)} autoComplete="family-name" />
            </div>
          </div>
          <div className="mt-3">
            <span className={label}>Date of birth</span>
            <input className={input} type="date" value={dob} onChange={(e) => setDob(e.target.value)} max={today} />
          </div>
          <div className="mt-3 grid grid-cols-[110px_1fr] gap-3">
            <div>
              <span className={label}>License state</span>
              <select className={input} value={dlState} onChange={(e) => setDlState(e.target.value)}>
                {US_STATES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <span className={label}>Driver&apos;s license number</span>
              <input className={input} inputMode="numeric" value={dlNumber} onChange={(e) => setDlNumber(e.target.value)} disabled={notGA} />
            </div>
          </div>
          {notGA && (
            <p className="mt-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-red-800">
              We can only accept a Georgia driver&apos;s license. If you have a Georgia license, select GA. Otherwise, please call the office that interviewed you.
            </p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <span className={label}>License expiration date</span>
              <input className={input} type="date" value={dlExpires} onChange={(e) => setDlExpires(e.target.value)} disabled={notGA} />
            </div>
            <div>
              <span className={label}>Year first licensed</span>
              <input className={input} inputMode="numeric" placeholder="e.g. 2015" value={firstYear} onChange={(e) => setFirstYear(e.target.value.replace(/\D/g, "").slice(0, 4))} disabled={notGA} />
            </div>
          </div>
        </Card>
      )}

      {wants("MVR") && (
        <Card title="1. Georgia driving record (3-year MVR)">
          <ul className="list-disc pl-5 text-[15px] text-slate-700 space-y-1">
            <li>
              Get it online from Georgia DDS at{" "}
              <a className="text-sky-700 underline" href="https://dds.drives.ga.gov/" target="_blank" rel="noreferrer">dds.drives.ga.gov</a>{" "}
              (DDS Online Services; you&apos;ll need an account and a card). Choose the <strong>3-year Driver History Report</strong>, $7.00.
            </li>
            <li>Or get one in person at any DDS Customer Service Center (bring form DDS-18).</li>
            <li>The online report can be printed but not downloaded: use <strong>Print → Save as PDF</strong> and upload the PDF, or take clear photos of each printed page.</li>
            <li>It must be dated within the last 30 days.</li>
          </ul>
          <FilePicker files={files.mvr} multiple onAdd={(l) => add("mvr", l, false)} onRemove={(id) => setFiles((c) => ({ ...c, mvr: c.mvr.filter((f) => f.id !== id) }))} />
        </Card>
      )}

      {wants("Drivers License") && (
        <Card title="2. Georgia driver's license (front and back)">
          <p className="text-[15px] text-slate-700">Clear photos of your valid Georgia license. Lay it flat, fill the frame, no glare.</p>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div>
              <span className={label}>Front</span>
              <FilePicker files={files.dl_front} onAdd={(l) => add("dl_front", l, true)} onRemove={() => setFiles((c) => ({ ...c, dl_front: [] }))} />
            </div>
            <div>
              <span className={label}>Back</span>
              <FilePicker files={files.dl_back} onAdd={(l) => add("dl_back", l, true)} onRemove={() => setFiles((c) => ({ ...c, dl_back: [] }))} />
            </div>
          </div>
        </Card>
      )}

      {wants("Criminal History") && (
        <Card title="3. Criminal history report">
          <p className="text-[15px] text-slate-700">
            Request it in person at your local sheriff&apos;s office or police department, then upload it here (a PDF or clear photos of each page).
          </p>
          <FilePicker files={files.criminal} multiple onAdd={(l) => add("criminal", l, false)} onRemove={(id) => setFiles((c) => ({ ...c, criminal: c.criminal.filter((f) => f.id !== id) }))} />
        </Card>
      )}

      {error && <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-red-800">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={Boolean(busy) || (p.purpose === "initial" && notGA)}
        className="h-12 rounded-xl bg-sky-700 text-white text-[17px] font-semibold disabled:opacity-50"
      >
        {busy ?? "Submit documents"}
      </button>
      <p className="text-[12px] text-slate-500 text-center">Your documents are stored privately and only used for your employment application.</p>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
      <h2 className="text-[17px] font-semibold mb-2">{title}</h2>
      {children}
    </section>
  )
}

function FilePicker({
  files,
  multiple,
  onAdd,
  onRemove,
}: {
  files: Picked[]
  multiple?: boolean
  onAdd: (l: FileList | null) => void
  onRemove: (id: string) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="mt-2">
      {files.map((f) => (
        <div key={f.id} className="flex items-center gap-2 py-1.5 text-[15px]">
          <span className="text-emerald-700">✓</span>
          <span className="truncate flex-1">{f.name}</span>
          <button type="button" className="text-slate-500 underline text-[14px]" onClick={() => onRemove(f.id)}>Remove</button>
        </div>
      ))}
      {(multiple || files.length === 0) && (
        <button
          type="button"
          onClick={() => ref.current?.click()}
          className="mt-1 w-full h-11 rounded-lg border-2 border-dashed border-slate-300 text-slate-700 font-medium hover:border-sky-500"
        >
          {files.length ? "Add another page" : "Take photo or choose file"}
        </button>
      )}
      <input
        ref={ref}
        type="file"
        accept="image/*,application/pdf"
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          onAdd(e.target.files)
          e.target.value = ""
        }}
      />
    </div>
  )
}
