"use client"

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react"
import { Camera, Film, ImagePlus, MapPin, Phone, X } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { createSupabaseBrowser } from "@/lib/supabase/client"
import {
  FOLLOW_UP_ISSUES,
  listCustomerFollowUpsBrowser,
  type ActiveCustomer,
  type CustomerFollowUp,
  type FollowUpMedia,
} from "@/lib/entities/follow-up/shared"
import { submitFollowUp, type SubmitState } from "./actions"
import { CustomerSelectSheet, CustomerTrigger } from "./CustomerPicker"
import { VoiceNote } from "./VoiceNote"
import { useBottomBar } from "../bottom-bar"

const initial: SubmitState = {}

// Inline cyan chevron for select-style triggers (same as sign-out).
const SELECT_CHEVRON_STYLE: React.CSSProperties = {
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'><path d='M1 1.5 L6 6.5 L11 1.5' stroke='%2338bdf8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 14px center",
  backgroundSize: "12px 8px",
}

// Normalize any picked/captured image to a right-side-up, downsized JPEG using
// only browser APIs. createImageBitmap applies the EXIF orientation tag (so
// portrait phone photos aren't sideways); canvas.toBlob re-encodes as JPEG.
// iOS Safari already converts an iPhone's HEIC to JPEG at the file-input
// boundary, so HEIC never reaches here.
async function toJpeg(file: File, maxDim = 2000, quality = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" })
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Could not process image.")
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode JPEG."))),
      "image/jpeg",
      quality,
    ),
  )
}

interface Props {
  techName: string
  authUserId: string
  customers: ActiveCustomer[]
}

export function FollowUpForm({ techName, authUserId, customers }: Props) {
  const [customerId, setCustomerId] = useState("")
  const [issue, setIssue] = useState("")
  const [description, setDescription] = useState("")
  const [equipmentOff, setEquipmentOff] = useState<boolean | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow the description to fit its content (the page scrolls once it's
  // taller than the viewport). Runs whenever the text changes — including
  // voice-note inserts and the reset-to-empty after submit/clear.
  useEffect(() => {
    const el = descRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [description])

  // Object-URL thumbnails for the attached media; revoked when files change.
  const [previews, setPreviews] = useState<{ url: string; isVideo: boolean }[]>([])
  useEffect(() => {
    const next = files.map((f) => ({
      url: URL.createObjectURL(f),
      isVideo: f.type.startsWith("video/"),
    }))
    setPreviews(next)
    return () => next.forEach((p) => URL.revokeObjectURL(p.url))
  }, [files])

  function addFiles(list: FileList | null) {
    const picked = Array.from(list ?? [])
    if (picked.length) setFiles((prev) => [...prev, ...picked])
  }

  const [pickerOpen, setPickerOpen] = useState(false)
  const [history, setHistory] = useState<CustomerFollowUp[] | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const [state, formAction, pending] = useActionState(submitFollowUp, initial)
  const [, startTransition] = useTransition()
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [showToast, setShowToast] = useState(false)
  const lastResult = useRef(state)

  const selected = customers.find((c) => String(c.customer_id) === customerId)

  // Fetch the customer's follow-up history when one is selected.
  useEffect(() => {
    setHistory(null)
    if (!customerId) return
    let cancelled = false
    listCustomerFollowUpsBrowser(Number(customerId))
      .then((rows) => {
        if (!cancelled) setHistory(rows)
      })
      .catch(() => {
        if (!cancelled) setHistory([])
      })
    return () => {
      cancelled = true
    }
  }, [customerId])

  useEffect(() => {
    if (state !== lastResult.current) {
      lastResult.current = state
      if (state.ok) {
        setCustomerId("")
        setIssue("")
        setDescription("")
        setEquipmentOff(null)
        setFiles([])
        if (cameraInputRef.current) cameraInputRef.current.value = ""
        if (uploadInputRef.current) uploadInputRef.current.value = ""
        setShowToast(true)
        const t = setTimeout(() => setShowToast(false), 2500)
        return () => clearTimeout(t)
      }
    }
  }, [state])

  const valid = Boolean(customerId && issue && description.trim())
  const busy = uploading || pending
  const hasContent = Boolean(
    customerId || issue || description.trim() || files.length > 0,
  )

  function clearForm() {
    setCustomerId("")
    setIssue("")
    setDescription("")
    setEquipmentOff(null)
    setFiles([])
    if (cameraInputRef.current) cameraInputRef.current.value = ""
    if (uploadInputRef.current) uploadInputRef.current.value = ""
    setUploadError(null)
  }

  async function doSubmit() {
    if (!valid || busy) return
    setUploadError(null)
    setUploading(true)
    try {
      const supabase = createSupabaseBrowser()
      const media: FollowUpMedia[] = []
      for (const file of files) {
        const isVideo = file.type.startsWith("video/")
        // Photos are normalized to JPEG (see toJpeg); videos upload as-is.
        const body = isVideo ? file : await toJpeg(file)
        const ext = isVideo
          ? file.name.includes(".")
            ? file.name.split(".").pop()
            : "bin"
          : "jpg"
        const path = `${authUserId}/${crypto.randomUUID()}.${ext}`
        const { error } = await supabase.storage
          .from("follow-ups")
          .upload(path, body, {
            contentType: isVideo ? file.type || undefined : "image/jpeg",
          })
        if (error) throw new Error(`Upload failed: ${error.message}`)
        media.push({ path, type: isVideo ? "video" : "image" })
      }
      const fd = new FormData()
      fd.set(
        "payload",
        JSON.stringify({
          customer_id: Number(customerId),
          issue,
          description: description.trim(),
          equipment_off: equipmentOff,
          media,
        }),
      )
      startTransition(() => formAction(fd))
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.")
    } finally {
      setUploading(false)
    }
  }

  // Keep the latest doSubmit reachable from the (stable) bottom-bar button.
  const doSubmitRef = useRef(doSubmit)
  useEffect(() => {
    doSubmitRef.current = doSubmit
  })

  // Once a customer is chosen, the bottom nav morphs into the Submit button;
  // Clear (or a successful submit) reverts it to the module nav.
  const { setAction } = useBottomBar()
  useEffect(() => {
    if (!customerId) {
      setAction(null)
      return
    }
    setAction({
      label: uploading ? "Uploading…" : pending ? "Saving…" : "Submit follow-up",
      disabled: !valid || busy,
      pending: busy,
      onClick: () => doSubmitRef.current(),
    })
    return () => setAction(null)
  }, [customerId, valid, busy, uploading, pending, setAction])

  const openCount = history?.filter((h) => h.status === "open").length ?? 0
  const closedCount = history?.filter((h) => h.status === "closed").length ?? 0
  const telHref = selected?.phone ? `tel:${selected.phone.replace(/[^+\d]/g, "")}` : null

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-ink-dim">
          Submitting as <span className="text-ink font-medium">{techName}</span>.
        </div>
        {hasContent && (
          <button
            type="button"
            onClick={clearForm}
            className={cn(
              "text-xs text-ink-dim rounded-lg px-2.5 py-1 border border-line-soft",
              "transition-[background-color,color,transform] duration-150 ease-out",
              "hover:text-ink hover:bg-white/5 active:scale-[0.97]",
            )}
          >
            Clear
          </button>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          doSubmit()
        }}
        className="flex flex-col gap-3"
      >
        {!selected && (
          <CustomerTrigger
            onOpen={() => setPickerOpen(true)}
            chevronStyle={SELECT_CHEVRON_STYLE}
          />
        )}

        {selected && (
          <div className="rounded-xl p-3 bg-bg-elev/60 border border-line-soft flex gap-3">
            {/* Left: name, address, phone */}
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              <div className="text-base text-ink font-medium truncate">
                {selected.customer_name}
              </div>
              {selected.address && (
                <div className="flex items-start gap-1.5 text-sm text-ink-dim">
                  <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0" strokeWidth={2} />
                  <span>{selected.address}</span>
                </div>
              )}
              {telHref ? (
                <a
                  href={telHref}
                  className="inline-flex items-center gap-1.5 text-sm text-cyan active:opacity-70"
                >
                  <Phone className="w-3.5 h-3.5" strokeWidth={2} />
                  {selected.phone}
                </a>
              ) : (
                <div className="text-sm text-ink-mute">No phone on file</div>
              )}
            </div>

            {/* Right: Change (top) + follow-ups counts (bottom) */}
            <div className="shrink-0 flex flex-col items-end justify-between gap-2">
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className={cn(
                  "text-xs text-cyan rounded-lg px-2.5 py-1",
                  "transition-[background-color,transform] duration-150 ease-out",
                  "hover:bg-cyan/5 active:scale-[0.97]",
                )}
              >
                Change
              </button>
              <button
                type="button"
                onClick={() => setShowHistory(true)}
                disabled={history === null}
                className={cn(
                  "rounded-lg px-2.5 py-1.5 border text-center",
                  "transition-[background-color,transform] duration-150 ease-out active:scale-[0.97]",
                  history === null
                    ? "text-ink-mute border-line-soft"
                    : openCount > 0
                      ? "text-amber-300 border-amber-300/30 bg-amber-300/5"
                      : "text-ink-dim border-line-soft hover:bg-white/5",
                )}
              >
                {history === null ? (
                  <span className="text-xs">Loading…</span>
                ) : (
                  <span className="flex items-center gap-2.5">
                    <span className="flex flex-col leading-tight">
                      <span className="text-[9px] uppercase tracking-wide text-ink-mute">
                        Open
                      </span>
                      <span className="text-sm font-medium tabular-nums">{openCount}</span>
                    </span>
                    <span className="flex flex-col leading-tight">
                      <span className="text-[9px] uppercase tracking-wide text-ink-mute">
                        Closed
                      </span>
                      <span className="text-sm font-medium tabular-nums">{closedCount}</span>
                    </span>
                  </span>
                )}
              </button>
            </div>
          </div>
        )}

        <select
          value={issue}
          onChange={(e) => {
            const next = e.target.value
            setIssue(next)
            // "Equipment off?" only applies to an equipment issue.
            if (next !== "Equipment Issue") setEquipmentOff(null)
          }}
          style={SELECT_CHEVRON_STYLE}
          className={cn(
            "appearance-none w-full h-11 pl-3.5 pr-10 text-base rounded-lg",
            "bg-[#0E1C2A] border border-line",
            issue ? "text-ink" : "text-ink-mute",
            "focus:outline-none focus:border-cyan focus-visible:ring-2 focus-visible:ring-cyan/30",
          )}
        >
          <option value="" disabled>
            Select issue…
          </option>
          {FOLLOW_UP_ISSUES.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>

        {/* Description composer: an auto-growing textarea with the voice-note
            mic and a Clear affordance in its footer, all inside one box. */}
        <div
          className={cn(
            "rounded-lg bg-[#0E1C2A] border border-line",
            "focus-within:border-cyan focus-within:ring-2 focus-within:ring-cyan/30",
            "transition-[border-color,box-shadow] duration-150",
          )}
        >
          <textarea
            ref={descRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the issue…"
            rows={4}
            className={cn(
              "block w-full px-3.5 pt-2.5 pb-1 text-base resize-none overflow-hidden bg-transparent",
              "text-ink placeholder:text-ink-mute focus:outline-none",
            )}
          />
          <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5">
            {description.trim() ? (
              <button
                type="button"
                onClick={() => {
                  setDescription("")
                  descRef.current?.focus()
                }}
                aria-label="Clear description"
                className={cn(
                  "w-7 h-7 grid place-items-center rounded-full text-ink-dim",
                  "hover:text-ink hover:bg-white/5 active:scale-90",
                  "transition-[color,background-color,transform] duration-150 ease-out",
                )}
              >
                <X className="w-4 h-4" strokeWidth={2} />
              </button>
            ) : (
              <span />
            )}
            <VoiceNote
              customer={selected?.customer_name ?? ""}
              issue={issue}
              onResult={(t) =>
                setDescription((d) => (d.trim() ? `${d.trim()}\n${t}` : t))
              }
            />
          </div>
        </div>

        {/* Equipment off? — only relevant to an equipment issue */}
        {issue === "Equipment Issue" && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-ink-dim">Equipment off?</span>
            <div className="flex gap-1.5">
              {([
                ["Yes", true],
                ["No", false],
              ] as const).map(([label, val]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setEquipmentOff(equipmentOff === val ? null : val)}
                  className={cn(
                    "px-3.5 h-9 rounded-lg text-sm border",
                    "transition-[background-color,border-color,color,transform] duration-150 ease-out",
                    "active:scale-[0.97]",
                    equipmentOff === val
                      ? "bg-cyan/10 border-cyan/50 text-ink"
                      : "bg-[#0E1C2A] border-line text-ink-dim",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Media — Camera opens the device camera directly (capture); Upload
            picks from the library. Both accumulate into `files`. */}
        <div className="flex flex-col gap-2.5">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              className={cn(
                "flex-1 h-11 rounded-lg flex items-center justify-center gap-2 text-sm font-medium",
                "border border-cyan/30 bg-cyan/[0.06] text-cyan",
                "transition-[background-color,transform] duration-150 ease-out",
                "hover:bg-cyan/10 active:scale-[0.98]",
              )}
            >
              <Camera className="w-4 h-4" strokeWidth={2} /> Camera
            </button>
            <button
              type="button"
              onClick={() => uploadInputRef.current?.click()}
              className={cn(
                "flex-1 h-11 rounded-lg flex items-center justify-center gap-2 text-sm font-medium",
                "border border-line bg-[#0E1C2A] text-ink-dim",
                "transition-[background-color,color,transform] duration-150 ease-out",
                "hover:text-ink hover:bg-white/[0.03] active:scale-[0.98]",
              )}
            >
              <ImagePlus className="w-4 h-4" strokeWidth={2} /> Upload
            </button>
          </div>

          {/* Hidden inputs driven by the buttons above. */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*,video/*"
            capture="environment"
            hidden
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ""
            }}
          />
          <input
            ref={uploadInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ""
            }}
          />

          {previews.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {previews.map((p, i) => (
                <div
                  key={i}
                  className="relative w-16 h-16 rounded-lg overflow-hidden border border-line-soft bg-bg-elev"
                >
                  {p.isVideo ? (
                    <div className="w-full h-full grid place-items-center text-ink-mute">
                      <Film className="w-5 h-5" strokeWidth={1.8} />
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.url} alt="" className="w-full h-full object-cover" />
                  )}
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    aria-label="Remove attachment"
                    className="absolute top-0.5 right-0.5 w-5 h-5 grid place-items-center rounded-full bg-black/60 text-white active:scale-90"
                  >
                    <X className="w-3 h-3" strokeWidth={2.4} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {(uploadError || state.error) && (
          <p className="text-coral text-sm">{uploadError ?? state.error}</p>
        )}

        {/* Submit lives in the bottom nav (it morphs into the Submit button
            once a customer is selected — see BottomNav / useBottomBar). A
            hidden submit input keeps the form's Enter-to-submit behavior. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden />
      </form>

      {pickerOpen && (
        <CustomerSelectSheet
          customers={customers}
          value={customerId}
          onPick={(id) => {
            setCustomerId(String(id))
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {showHistory && history !== null && selected && (
        <HistorySheet
          customerName={selected.customer_name}
          rows={history}
          onClose={() => setShowHistory(false)}
        />
      )}

      {showToast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-28 bg-grass/10 border border-grass/30 text-grass text-sm px-4 py-2.5 rounded-lg shadow-card">
          Follow-up submitted.
        </div>
      )}
    </div>
  )
}

function HistorySheet({
  customerName,
  rows,
  onClose,
}: {
  customerName: string
  rows: CustomerFollowUp[]
  onClose: () => void
}) {
  const [closing, setClosing] = useState(false)

  // Lock body scroll + close on Escape (same behavior as the pickers).
  useEffect(() => {
    const original = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = original
      window.removeEventListener("keydown", onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dismiss = () => {
    setClosing(true)
    setTimeout(onClose, 180)
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Follow-up history" className="fixed inset-0 z-40">
      <div
        onClick={dismiss}
        className={cn(
          "absolute inset-0 bg-black/50 backdrop-blur-[2px]",
          "transition-opacity duration-200 ease-out",
          closing ? "opacity-0" : "opacity-100 animate-[fade-in_180ms_ease-out_both]",
        )}
      />
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 max-h-[80vh] flex flex-col",
          "bg-bg-elev border-t border-line rounded-t-2xl shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.5)]",
          "transition-transform ease-[cubic-bezier(0.165,0.84,0.44,1)]",
          closing
            ? "translate-y-full duration-[180ms]"
            : "translate-y-0 duration-[260ms] animate-[sheet-slide-up_260ms_cubic-bezier(0.165,0.84,0.44,1)_both]",
        )}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <div className="w-10 h-1.5 rounded-full bg-line-soft mx-auto absolute left-1/2 -translate-x-1/2 top-2" />
          <h2 className="font-display text-base pt-2 truncate">{customerName}</h2>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close"
            className={cn(
              "w-9 h-9 grid place-items-center rounded-lg text-ink-dim",
              "hover:bg-white/5 hover:text-ink active:scale-[0.92]",
              "transition-[color,background-color,transform] duration-150 ease-out",
            )}
          >
            <X className="w-5 h-5" strokeWidth={1.8} />
          </button>
        </div>

        <div className="overflow-y-auto overscroll-contain px-4 pb-6 pt-1 flex flex-col gap-2.5">
          {rows.length === 0 && (
            <p className="text-ink-mute text-sm py-4">No follow-ups for this customer yet.</p>
          )}
          {rows.map((r) => (
            <div
              key={r.id}
              className="rounded-xl p-3 bg-bg/60 border border-line-soft flex flex-col gap-1"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm text-ink font-medium flex-1">{r.issue}</span>
                <span
                  className={cn(
                    "text-[10px] uppercase tracking-wide rounded-full px-2 py-0.5 border",
                    r.status === "open"
                      ? "text-amber-300 border-amber-300/30 bg-amber-300/5"
                      : "text-grass border-grass/30 bg-grass/5",
                  )}
                >
                  {r.status}
                </span>
              </div>
              <p className="text-sm text-ink-dim whitespace-pre-wrap">{r.description}</p>
              <p className="text-xs text-ink-mute">
                {r.tech_name ?? "Unknown tech"} ·{" "}
                {new Date(r.created_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
