"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, RefreshCw, Lock, CalendarCheck } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Pill } from "@/components/ui/pill"
import { OptionPills } from "@/components/ui/option-pills"
import { Select } from "@/components/ui/select"
import { formatDate } from "@/lib/utils/format"
import { confirmPaymentOnFile, saveOnboarding } from "./actions"

export interface OnboardingBody {
  body_type?: string
  is_primary?: boolean
  is_screened_in?: boolean | null
  chlorination_system?: string | null
  filter_type?: string | null
  vegetation_level?: string | null
  has_auto_cleaner?: boolean | null
  has_dogs?: boolean | null
  pool_volume?: number | null
  access_instructions?: string | null
  special_instructions?: string | null
}

export interface OnboardingRow {
  status?: string | null
  payment_on_file?: boolean | null
  assigned_route?: string | null
  assigned_tech?: string | null
  first_service_date?: string | null
  service_day_preference?: string | null
  preferred_start_date?: string | null
}

export interface OnboardingLead {
  first_name?: string | null
  last_name?: string | null
  status?: string | null
  qbo_customer_id?: string | null
  quoted_per_visit?: number | null
  visits_per_week?: number | null
  first_months_deposit?: number | null
  bodies?: OnboardingBody[] | null
  onboarding?: OnboardingRow | null
}

const inputCls =
  "w-full bg-[#0E1C2A] border border-line rounded-md px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"

const YES_NO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]
const ynToBool = (v: string): boolean | null => (v === "yes" ? true : v === "no" ? false : null)
const boolToYn = (b: boolean | null | undefined): string => (b === true ? "yes" : b === false ? "no" : "")

const ONBOARDING_STATUS_LABEL: Record<string, string> = {
  pending_payment: "Pending payment",
  payment_on_file: "Payment on file",
  pending_routing: "Pending scheduling",
  route_assigned: "Scheduled",
  complete: "Active",
}

export function OnboardingForm({
  leadId, lead, cardToken, cardVaultUrl, depositDollars, qboReady, tokenError,
}: {
  leadId: string
  lead: OnboardingLead
  cardToken: string | null
  cardVaultUrl: string
  depositDollars: number
  qboReady: boolean
  tokenError: string | null
}) {
  const router = useRouter()
  const alreadyPaid = lead.status === "converted" || !!lead.onboarding?.payment_on_file
  const [editing, setEditing] = useState(false)

  // A converted lead lands on the status screen; "Edit pool details" reveals the form.
  if (alreadyPaid && !editing) {
    return <StatusScreen lead={lead} onEdit={() => setEditing(true)} />
  }

  return (
    <Wizard
      leadId={leadId}
      lead={lead}
      cardToken={cardToken}
      cardVaultUrl={cardVaultUrl}
      depositDollars={depositDollars}
      qboReady={qboReady}
      tokenError={tokenError}
      startPaid={alreadyPaid}
      onAllDone={() => { setEditing(false); router.refresh() }}
    />
  )
}

/* ── Status screen (mirrors what the website shows a converted customer) ── */
function StatusScreen({ lead, onEdit }: { lead: OnboardingLead; onEdit: () => void }) {
  const ob = lead.onboarding
  const statusLabel = ONBOARDING_STATUS_LABEL[ob?.status ?? ""] ?? "Active"
  const scheduled = !!(ob?.first_service_date || ob?.assigned_route || ob?.assigned_tech)
  return (
    <div className="max-w-xl mx-auto">
      <Card>
        <div className="px-6 py-6 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-grass/15 text-grass flex items-center justify-center"><Check className="w-5 h-5" strokeWidth={2.5} /></span>
            <div>
              <div className="text-ink text-lg font-display">Accepted &amp; onboarded</div>
              <div className="text-ink-mute text-[12px]">Onboarding status: {statusLabel}</div>
            </div>
            <Pill tone="grass" className="ml-auto">Payment on file</Pill>
          </div>

          <div className="border-t border-line-soft pt-4">
            {scheduled ? (
              <div className="flex flex-col gap-2 text-[13px]">
                <Row label="First visit" value={ob?.first_service_date ? formatDate(ob.first_service_date) : "TBD"} icon={<CalendarCheck className="w-4 h-4 text-cyan" />} />
                <Row label="Route / day" value={ob?.assigned_route || "—"} />
                <Row label="Technician" value={ob?.assigned_tech || "—"} />
              </div>
            ) : (
              <p className="text-ink-dim text-[13px]">We&apos;ll reach out to schedule the first visit — route and tech are assigned during routing.</p>
            )}
          </div>

          <Button variant="default" size="sm" className="self-start" onClick={onEdit}>Edit pool details</Button>
        </div>
      </Card>
    </div>
  )
}

function Row({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-mute flex items-center gap-1.5">{icon}{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  )
}

/* ── Step tracker ── */
function StepTracker({ step }: { step: "payment" | "details" | "done" }) {
  const steps: { key: typeof step; label: string }[] = [
    { key: "payment", label: "Payment" },
    { key: "details", label: "Pool details" },
    { key: "done", label: "Done" },
  ]
  const order = { payment: 0, details: 1, done: 2 }
  const cur = order[step]
  return (
    <div className="flex items-center gap-2 max-w-2xl mx-auto w-full">
      {steps.map((s, i) => {
        const done = i < cur
        const active = i === cur
        return (
          <div key={s.key} className="flex items-center gap-2 flex-1 last:flex-none">
            <span className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-medium border ${
              done ? "bg-grass/15 text-grass border-grass/30" : active ? "bg-cyan/15 text-cyan border-cyan/40" : "bg-white/[0.03] text-ink-mute border-line"}`}>
              {done ? <Check className="w-3.5 h-3.5" strokeWidth={2.5} /> : i + 1}
            </span>
            <span className={`text-[12px] ${active ? "text-ink" : done ? "text-ink-dim" : "text-ink-mute"}`}>{s.label}</span>
            {i < steps.length - 1 && <span className={`h-px flex-1 ${done ? "bg-grass/30" : "bg-line"}`} />}
          </div>
        )
      })}
    </div>
  )
}

/* ── The 2-step wizard ── */
function Wizard({
  leadId, lead, cardToken, cardVaultUrl, depositDollars, qboReady, tokenError, startPaid, onAllDone,
}: {
  leadId: string
  lead: OnboardingLead
  cardToken: string | null
  cardVaultUrl: string
  depositDollars: number
  qboReady: boolean
  tokenError: string | null
  startPaid: boolean
  onAllDone: () => void
}) {
  const router = useRouter()
  const [cardComplete, setCardComplete] = useState(startPaid)
  const [payError, setPayError] = useState<string | null>(null)
  const [, startPay] = useTransition()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const [saved, setSaved] = useState(false)
  const step: "payment" | "details" | "done" = saved ? "done" : cardComplete ? "details" : "payment"

  // Origin-checked card-vault messages → flip to paid.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== cardVaultUrl) return
      const data = e.data as { type?: string; height?: number }
      if (data?.type === "card-vault-success") {
        setCardComplete(true)
        startPay(async () => {
          const r = await confirmPaymentOnFile(leadId)
          if (!r.ok) setPayError(r.error ?? "Could not record payment on file.")
        })
      }
      if (data?.type === "card-vault-resize" && data.height && iframeRef.current) {
        iframeRef.current.style.height = `${data.height}px`
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [leadId, cardVaultUrl])

  // Pool details (prefill from primary body + existing onboarding).
  const primary = lead.bodies?.find((b) => b.is_primary) ?? lead.bodies?.[0] ?? {}
  const [screened, setScreened] = useState(boolToYn(primary.is_screened_in))
  const [poolVolume, setPoolVolume] = useState(primary.pool_volume ? String(primary.pool_volume) : "")
  const [chlorination, setChlorination] = useState(primary.chlorination_system ?? "")
  const [filter, setFilter] = useState(primary.filter_type ?? "")
  const [vegetation, setVegetation] = useState(primary.vegetation_level ?? "")
  const [autoCleaner, setAutoCleaner] = useState(boolToYn(primary.has_auto_cleaner))
  const [dogs, setDogs] = useState(boolToYn(primary.has_dogs))
  const [access, setAccess] = useState(primary.access_instructions ?? "")
  const [special, setSpecial] = useState(primary.special_instructions ?? "")
  const [serviceDay, setServiceDay] = useState(lead.onboarding?.service_day_preference ?? "")
  const [startDate, setStartDate] = useState(lead.onboarding?.preferred_start_date ?? "")

  const [saving, startSave] = useTransition()
  const [saveError, setSaveError] = useState<string | null>(null)

  function save() {
    setSaveError(null)
    startSave(async () => {
      const r = await saveOnboarding(leadId, {
        preferred_start_date: startDate || null,
        service_day_preference: (serviceDay || null) as never,
        pool_details: {
          is_screened_in: ynToBool(screened),
          chlorination_system: (chlorination || null) as never,
          filter_type: (filter || null) as never,
          vegetation_level: (vegetation || null) as never,
          has_auto_cleaner: ynToBool(autoCleaner),
          has_dogs: ynToBool(dogs),
          pool_volume: poolVolume ? parseInt(poolVolume, 10) : null,
          access_instructions: access || null,
          special_instructions: special || null,
        },
        agreed_to_terms: true,
      })
      if (!r.ok) { setSaveError(r.error ?? "Could not save pool details."); return }
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-5">
      <StepTracker step={step} />

      {/* Step 1 — Card */}
      <Card>
        <div className="px-5 pt-4 pb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.12em] text-ink-mute">1 · Card on file</span>
          {cardComplete && <Pill tone="grass">Payment on file</Pill>}
        </div>
        <div className="px-5 pb-4">
          {cardComplete ? (
            <div className="flex items-center gap-2 text-[13px] text-grass">
              <Check className="w-4 h-4" strokeWidth={2.5} /> Card collected — lead converted.
              {payError && <span className="text-coral ml-2">({payError})</span>}
            </div>
          ) : !qboReady ? (
            <div className="text-[13px] text-sun bg-sun/10 border border-sun/20 rounded-md p-3 flex items-center justify-between gap-3">
              <span>Customer is still syncing to QuickBooks — the card step needs the QBO customer. Retry in a moment.</span>
              <Button size="sm" variant="default" onClick={() => router.refresh()}><RefreshCw className="w-3.5 h-3.5" /> Retry</Button>
            </div>
          ) : tokenError || !cardToken ? (
            <div className="text-[13px] text-coral bg-coral/10 border border-coral/20 rounded-md p-3">
              Couldn&apos;t start card collection{tokenError ? `: ${tokenError}` : "."}
            </div>
          ) : (
            <>
              <p className="text-ink-mute text-[12px] mb-2">
                {depositDollars > 0
                  ? `A temporary hold of $${depositDollars} validates the card (first-month deposit, not a charge).`
                  : "Card is saved on file for autopay."}
              </p>
              <iframe
                ref={iframeRef}
                title="Card collection"
                src={`${cardVaultUrl}/collect?token=${cardToken}&embed=true`}
                className="w-full rounded-md border border-line bg-white"
                style={{ height: 420 }}
              />
            </>
          )}
        </div>
      </Card>

      {/* Step 2 — Pool details (locked until the card is on file) */}
      <Card>
        <div className="px-5 pt-4 pb-2 text-[11px] uppercase tracking-[0.12em] text-ink-mute">2 · Pool details</div>
        {!cardComplete ? (
          <div className="px-5 pb-5">
            <div className="text-[13px] text-ink-mute bg-white/[0.02] border border-line-soft rounded-md p-4 flex items-center gap-2">
              <Lock className="w-4 h-4 shrink-0" /> Complete the card step first to unlock pool details.
            </div>
          </div>
        ) : (
          <div className="px-5 pb-5 flex flex-col gap-3">
            <Field label="Screened in?"><OptionPills value={screened} onChange={setScreened} options={YES_NO} disabled={saving} /></Field>
            <Field label="Pool volume (gallons)"><input value={poolVolume} onChange={(e) => setPoolVolume(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className={inputCls} placeholder="e.g. 15000" disabled={saving} /></Field>
            <Field label="Chlorination">
              <OptionPills value={chlorination} onChange={setChlorination} disabled={saving}
                options={[{ value: "salt", label: "Salt" }, { value: "tablet", label: "Tablet" }, { value: "liquid", label: "Liquid" }, { value: "other", label: "Other" }]} />
            </Field>
            <Field label="Filter type">
              <OptionPills value={filter} onChange={setFilter} disabled={saving}
                options={[{ value: "cartridge", label: "Cartridge" }, { value: "sand", label: "Sand" }, { value: "DE", label: "DE" }]} />
            </Field>
            <Field label="Vegetation">
              <OptionPills value={vegetation} onChange={setVegetation} disabled={saving}
                options={[{ value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }]} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Auto cleaner?"><OptionPills value={autoCleaner} onChange={setAutoCleaner} options={YES_NO} disabled={saving} /></Field>
              <Field label="Dogs on property?"><OptionPills value={dogs} onChange={setDogs} options={YES_NO} disabled={saving} /></Field>
            </div>
            <Field label="Access instructions"><input value={access} onChange={(e) => setAccess(e.target.value)} className={inputCls} placeholder="Gate code, side gate, etc." disabled={saving} /></Field>
            <Field label="Special instructions"><textarea value={special} onChange={(e) => setSpecial(e.target.value)} rows={2} className={inputCls} disabled={saving} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Preferred service day">
                <Select value={serviceDay} onChange={setServiceDay} disabled={saving} placeholder="No preference"
                  options={[
                    { value: "monday", label: "Monday" }, { value: "tuesday", label: "Tuesday" }, { value: "wednesday", label: "Wednesday" },
                    { value: "thursday", label: "Thursday" }, { value: "friday", label: "Friday" }, { value: "no_preference", label: "No preference" },
                  ]} />
              </Field>
              <Field label="Preferred start date"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} disabled={saving} /></Field>
            </div>

            {saveError && <div className="text-coral text-[13px] bg-coral/10 border border-coral/20 rounded-md p-3">{saveError}</div>}
            <div className="flex items-center gap-3">
              <Button variant="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save pool details"}</Button>
              {saved && (
                <span className="text-grass text-[13px] flex items-center gap-1">
                  <Check className="w-4 h-4" strokeWidth={2.5} /> Saved
                  <button type="button" className="ml-2 text-cyan hover:underline" onClick={onAllDone}>View status</button>
                </span>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-[0.1em] text-ink-mute">{label}</span>
      {children}
    </label>
  )
}
