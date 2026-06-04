"use client"

import { useActionState, useEffect, useRef, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { AddressAutocomplete, type PickedAddress } from "@/components/form/address-autocomplete"
import { checkServiceArea, calculateQuote } from "@/lib/leads/quote"
import { prettyOffice } from "../ui"
import { createInternalLead, type ActionState } from "../actions"

export type ChemTier = { med: number; low: number; high: number }
export type ChemEstimates = { weekly: ChemTier; biweekly: ChemTier }

const empty: ActionState = {}
const inputCls =
  "w-full bg-[#0E1C2A] border border-line rounded-md px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"
const labelCls = "block text-[11px] uppercase tracking-[0.1em] text-ink-mute mb-1"

type Office = "richmond_hill" | "brunswick" | "st_marys"
type DedupMatch = {
  customer_id: number; display_name: string; account_type: string | null
  has_qbo: boolean; redacted_phone: string | null; redacted_email: string | null
}
type SectionKey = "address" | "contact" | "details"

const OFFICES: { id: Office; label: string }[] = [
  { id: "richmond_hill", label: "Richmond Hill" },
  { id: "brunswick", label: "Brunswick" },
  { id: "st_marys", label: "St. Marys" },
]
const VISIT_LABEL: Record<string, string> = { "0.5": "Every other week", "1": "Weekly", "2": "Twice weekly" }
const VISITS_PER_MONTH: Record<string, number> = { "0.5": 2, "1": 4, "2": 8 }
const COND_LABEL: Record<string, string> = { good: "Good", needs_repair: "Needs repair", green_pool: "Green pool" }

export function NewLeadForm({ chem }: { chem: ChemEstimates | null }) {
  const router = useRouter()
  const [state, action, pending] = useActionState(createInternalLead, empty)

  // address
  const [street, setStreet] = useState("")
  const [city, setCity] = useState("")
  const [stateCode, setStateCode] = useState("GA")
  const [zip, setZip] = useState("")
  const [office, setOffice] = useState<Office>("brunswick")
  const area = checkServiceArea(zip)

  // contact
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")

  // dedup
  const [matches, setMatches] = useState<DedupMatch[]>([])
  const [dedupChecking, setDedupChecking] = useState(false)
  const [customerAction, setCustomerAction] = useState<"auto" | "use_existing" | "create_new">("auto")
  const [existingId, setExistingId] = useState<number | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // lead details
  const [primaryBody, setPrimaryBody] = useState<"pool" | "spa" | "fountain">("pool")
  const [fountain, setFountain] = useState(false)
  const [visits, setVisits] = useState<"0.5" | "1" | "2">("1")
  const [poolCondition, setPoolCondition] = useState<"good" | "needs_repair" | "green_pool">("good")
  const [issue, setIssue] = useState("")

  // accordion
  const [openSection, setOpenSection] = useState<SectionKey | null>("address")
  const advanced = useRef({ address: false, contact: false })

  const addressComplete = !!(street.trim() && city.trim() && zip.trim().length >= 5)
  const contactComplete = !!(firstName.trim() && lastName.trim() && (email.trim() || phone.trim()))

  useEffect(() => {
    if (openSection === "address" && addressComplete && !advanced.current.address) {
      const t = setTimeout(() => { advanced.current.address = true; setOpenSection("contact") }, 700)
      return () => clearTimeout(t)
    }
  }, [openSection, addressComplete])
  useEffect(() => {
    if (openSection === "contact" && contactComplete && !advanced.current.contact) {
      const t = setTimeout(() => { advanced.current.contact = true; setOpenSection("details") }, 700)
      return () => clearTimeout(t)
    }
  }, [openSection, contactComplete])

  const additionalBodies = fountain && primaryBody !== "fountain" ? 1 : 0
  const quote = calculateQuote(primaryBody, additionalBodies, Number(visits))
  const laborMonthly = quote.firstMonthsDeposit
  const tier = chem ? (visits === "0.5" ? chem.biweekly : chem.weekly) : null

  function onAddressPicked(a: PickedAddress) {
    setStreet(a.street); setCity(a.city); setStateCode(a.state || "GA"); setZip(a.zip)
    const o = checkServiceArea(a.zip).office
    if (o) setOffice(o)
  }
  function onZipChange(v: string) {
    setZip(v)
    const o = checkServiceArea(v).office
    if (o) setOffice(o)
  }

  const runDedup = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setCustomerAction("auto"); setExistingId(null)
    if (q.trim().length < 3) { setMatches([]); return }
    debounceRef.current = setTimeout(async () => {
      setDedupChecking(true)
      try {
        const r = await fetch("/api/leads/check-dedup", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q.trim() }),
        })
        const j = await r.json()
        setMatches(Array.isArray(j.matches) ? j.matches : [])
      } catch { setMatches([]) } finally { setDedupChecking(false) }
    }, 400)
  }, [])

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])
  useEffect(() => { if (state.ok && state.leadId) router.push(`/leads/${state.leadId}` as never) }, [state, router])

  const toggle = (s: SectionKey) => setOpenSection((cur) => (cur === s ? null : s))

  const customerSummary = customerAction === "use_existing" ? "Existing (attached)"
    : customerAction === "create_new" ? "New customer"
    : matches.length ? `${matches.length} possible match` : "New customer"

  return (
    <form action={action}>
      <div className="grid grid-cols-3 gap-5">
        {/* ── Left: accordion sections ─────────────────────────────── */}
        <div className="col-span-2 flex flex-col gap-4">

          {/* 1. Address */}
          <Accordion sectionKey="address" title="Address" open={openSection === "address"} complete={addressComplete} onToggle={toggle}
            summary={addressComplete
              ? <span className="flex items-center gap-2 truncate">
                  <span className="text-ink-dim truncate">{[street, city].filter(Boolean).join(", ")} {zip}</span>
                  <Pill tone={area.inArea ? "grass" : "coral"}>{area.inArea ? prettyOffice(office) : "Out of area"}</Pill>
                </span>
              : null}>
            <AddressAutocomplete onPicked={onAddressPicked} className={inputCls} />
            <div className="grid grid-cols-6 gap-3 mt-3">
              <Field cls="col-span-6" label="Street *"><input name="street" value={street} onChange={(e) => setStreet(e.target.value)} className={inputCls} disabled={pending} required /></Field>
              <Field cls="col-span-3" label="City *"><input name="city" value={city} onChange={(e) => setCity(e.target.value)} className={inputCls} disabled={pending} required /></Field>
              <Field cls="col-span-1" label="State"><input name="state" value={stateCode} onChange={(e) => setStateCode(e.target.value)} className={inputCls} disabled={pending} /></Field>
              <Field cls="col-span-2" label="ZIP *"><input name="zip" value={zip} onChange={(e) => onZipChange(e.target.value)} className={inputCls} disabled={pending} required /></Field>
              <Field cls="col-span-3" label="Office (auto from ZIP)">
                <OfficePill office={office} onChange={setOffice} disabled={pending} />
              </Field>
            </div>
          </Accordion>

          {/* 2. Contact */}
          <Accordion sectionKey="contact" title="Contact" open={openSection === "contact"} complete={contactComplete} onToggle={toggle}
            badge={dedupChecking ? "checking…" : undefined}
            summary={contactComplete
              ? <span className="flex items-center gap-2 truncate">
                  <span className="text-ink-dim truncate">{firstName} {lastName} · {email || phone}</span>
                  {customerAction === "use_existing" && <Pill tone="cyan">existing</Pill>}
                </span>
              : null}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name *"><input name="first_name" value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputCls} disabled={pending} required /></Field>
              <Field label="Last name *"><input name="last_name" value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputCls} disabled={pending} required /></Field>
              <Field label="Email"><input name="email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); runDedup(e.target.value || phone) }} className={inputCls} disabled={pending} placeholder="email or phone required" /></Field>
              <Field label="Phone"><input name="phone" type="tel" value={phone} onChange={(e) => { setPhone(e.target.value); runDedup(email || e.target.value) }} className={inputCls} disabled={pending} /></Field>
            </div>
            {matches.length > 0 && (
              <div className="border border-sun/30 bg-sun/10 rounded-md p-3 flex flex-col gap-2 mt-3">
                <div className="text-[12px] text-sun">{matches.length} possible existing customer{matches.length > 1 ? "s" : ""} — attach to one, or create new.</div>
                {matches.map((m) => (
                  <label key={m.customer_id} className="flex items-center gap-2 text-[13px] cursor-pointer">
                    <input type="radio" name="dedup_choice" className="accent-cyan" checked={customerAction === "use_existing" && existingId === m.customer_id}
                      onChange={() => { setCustomerAction("use_existing"); setExistingId(m.customer_id) }} />
                    <span className="text-ink">{m.display_name}</span>
                    <span className="text-ink-mute text-xs">{[m.redacted_phone, m.redacted_email].filter(Boolean).join(" · ")}</span>
                    {m.has_qbo && <Pill tone="grass">QBO</Pill>}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                  <input type="radio" name="dedup_choice" className="accent-cyan" checked={customerAction === "create_new"} onChange={() => { setCustomerAction("create_new"); setExistingId(null) }} />
                  <span className="text-ink-dim">None of these — create a new customer</span>
                </label>
              </div>
            )}
          </Accordion>

          {/* 3. Lead details */}
          <Accordion sectionKey="details" title="Lead details" open={openSection === "details"} complete onToggle={toggle}
            summary={<span className="text-ink-dim truncate">{cap(primaryBody)}{additionalBodies ? " + fountain" : ""} · {VISIT_LABEL[visits]} · {COND_LABEL[poolCondition]}</span>}>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Primary body"><select name="primary_body_type" value={primaryBody} onChange={(e) => setPrimaryBody(e.target.value as typeof primaryBody)} className={inputCls} disabled={pending}>
                <option value="pool">Pool</option><option value="spa">Spa</option><option value="fountain">Fountain</option></select></Field>
              <Field label="Visits / week"><select name="visits_per_week" value={visits} onChange={(e) => setVisits(e.target.value as typeof visits)} className={inputCls} disabled={pending}>
                <option value="0.5">Every other week</option><option value="1">Weekly</option><option value="2">Twice weekly</option></select></Field>
              <Field label="Pool condition"><select name="pool_condition" value={poolCondition} onChange={(e) => setPoolCondition(e.target.value as typeof poolCondition)} className={inputCls} disabled={pending}>
                <option value="good">Good</option><option value="needs_repair">Needs repair</option><option value="green_pool">Green pool</option></select></Field>
            </div>
            <label className="flex items-center gap-2 text-[12px] text-ink-dim mt-3">
              <input type="checkbox" name="additional_fountain" checked={fountain} onChange={(e) => setFountain(e.target.checked)} className="accent-cyan" disabled={pending || primaryBody === "fountain"} />
              Add a fountain (+$10/visit)
            </label>
            <Field cls="mt-3" label="Issue / notes"><textarea name="issue_description" value={issue} onChange={(e) => setIssue(e.target.value)} rows={3} className={inputCls} disabled={pending} /></Field>
          </Accordion>
        </div>

        {/* ── Right: quote + submit ────────────────────────────────── */}
        <div className="col-span-1">
          <div className="sticky top-6 flex flex-col gap-4">
            <Card>
              <div className="px-5 pt-4 pb-2 text-[11px] uppercase tracking-[0.12em] text-ink-mute">Estimated monthly</div>
              <div className="px-5 pb-4 text-[13px] flex flex-col gap-2">
                <Row label="Labor" value={`$${laborMonthly}/mo`} sub={`$${quote.perVisit}/visit · ${VISITS_PER_MONTH[visits]} visits`} />
                <Row label="Est. chemicals" value={tier ? `$${tier.med}/mo` : "—"} sub={tier ? `range $${tier.low}–$${tier.high}` : "estimate unavailable"} />
                <div className="border-t border-line-soft my-1" />
                <div className="flex justify-between items-baseline">
                  <span className="text-ink">Estimated monthly total</span>
                  <span className="text-cyan text-lg font-display">{tier ? `$${laborMonthly + tier.med}` : `$${laborMonthly}+`}</span>
                </div>
                {tier && <div className="text-right text-ink-mute text-[11px]">range ${laborMonthly + tier.low}–${laborMonthly + tier.high}</div>}
                <p className="text-ink-mute text-[11px] mt-1">Chemicals billed separately on usage; estimate from this month&apos;s data. Labor is the canonical rate that gets stored.</p>
              </div>
            </Card>

            <Card>
              <div className="px-5 pt-4 pb-2 text-[11px] uppercase tracking-[0.12em] text-ink-mute">Review</div>
              <div className="px-5 pb-4 text-[13px] flex flex-col gap-1.5">
                <Row label="Office" value={prettyOffice(office)} />
                <Row label="Service area" value={zip ? (area.inArea ? "In area" : "Out of area") : "—"} />
                <Row label="Customer" value={customerSummary} />
              </div>
            </Card>

            <input type="hidden" name="office" value={office} />
            <input type="hidden" name="customer_action" value={customerAction} />
            <input type="hidden" name="existing_customer_id" value={existingId ?? ""} />

            {state.error && <div className="text-coral text-[13px] bg-coral/10 border border-coral/20 rounded-md p-3">{state.error}</div>}
            <Button type="submit" variant="primary" disabled={pending}>{pending ? "Creating…" : "Create lead"}</Button>
          </div>
        </div>
      </div>
    </form>
  )
}

/* ── accordion section: header (title + summary + chevron) over a kept-mounted body ── */
function Accordion({
  sectionKey, title, open, complete = false, onToggle, summary, badge, children,
}: {
  sectionKey: SectionKey; title: string; open: boolean; complete?: boolean
  onToggle: (s: SectionKey) => void
  summary?: React.ReactNode; badge?: string; children: React.ReactNode
}) {
  return (
    <Card>
      <button type="button" onClick={() => onToggle(sectionKey)}
        className="w-full flex items-center gap-3 px-5 py-3 text-left">
        {complete
          ? <span className="w-4 h-4 rounded-full bg-grass/20 text-grass grid place-items-center shrink-0"><Check className="w-3 h-3" strokeWidth={3} /></span>
          : <span className="w-4 h-4 rounded-full border border-line shrink-0" />}
        <span className="text-[13px] font-medium text-ink shrink-0">{title}</span>
        {!open && summary && <span className="text-[12px] min-w-0 flex-1 truncate">{summary}</span>}
        {badge && <span className="text-[11px] text-ink-mute ml-auto">{badge}</span>}
        <ChevronDown className={`w-4 h-4 text-ink-mute shrink-0 transition-transform ${open ? "rotate-180" : ""} ${badge ? "" : "ml-auto"}`} strokeWidth={2} />
      </button>
      <div className={open ? "px-5 pb-4 border-t border-line-soft pt-3" : "hidden"}>{children}</div>
    </Card>
  )
}

/* ── office as a pill that opens a dropdown ── */
function OfficePill({ office, onChange, disabled }: { office: Office; onChange: (o: Office) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative inline-block">
      <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium border text-cyan bg-cyan/10 border-cyan/20 hover:brightness-110 disabled:opacity-50">
        {prettyOffice(office)}
        <ChevronDown className="w-3 h-3" strokeWidth={2} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 w-40 rounded-md border border-line bg-bg-elev shadow-card py-1">
            {OFFICES.map((o) => (
              <button key={o.id} type="button"
                onClick={() => { onChange(o.id); setOpen(false) }}
                className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-white/5 ${o.id === office ? "text-cyan" : "text-ink-dim"}`}>
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function Field({ label, cls = "", children }: { label: string; cls?: string; children: React.ReactNode }) {
  return <div className={cls}><label className={labelCls}>{label}</label>{children}</div>
}
function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex justify-between gap-3 items-start">
      <span className="text-ink-mute">{label}</span>
      <span className="text-right">
        <span className="text-ink">{value}</span>
        {sub && <span className="block text-ink-mute text-[11px]">{sub}</span>}
      </span>
    </div>
  )
}
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }
