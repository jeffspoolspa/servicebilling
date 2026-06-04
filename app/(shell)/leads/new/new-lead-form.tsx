"use client"

import { useActionState, useEffect, useRef, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { OptionPills } from "@/components/ui/option-pills"
import { AddressAutocomplete, type PickedAddress } from "@/components/form/address-autocomplete"
import { checkServiceArea, calculateMaintQuote, type ChemEstimates } from "@/lib/leads/quote"
import { prettyOffice } from "../ui"
import { createInternalLead, type ActionState } from "../actions"

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
const VISIT_LABEL: Record<string, string> = { "0.5": "Bi-weekly", "1": "Weekly", "2": "2x per week" }
const COND_LABEL: Record<string, string> = { good: "Good", needs_repair: "Needs repair", green_pool: "Green pool" }
const CONTACT_LABEL: Record<string, string> = { first_name: "first name", last_name: "last name", email: "email", phone: "phone" }

/** Progressively format a US phone as the user types → (xxx) xxx-xxxx. */
function formatPhone(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 10)
  if (d.length === 0) return ""
  if (d.length < 4) return `(${d}`
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

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
  // snapshot of the attached customer's saved values, so we can flag edits as overrides
  const [existingSnapshot, setExistingSnapshot] = useState<{ name: string; fields: Record<string, string> } | null>(null)
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
  const quote = calculateMaintQuote(
    { primaryBodyType: primaryBody, additionalBodyCount: additionalBodies, visitsPerWeek: Number(visits) },
    chem,
  )

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

  // Attach an existing customer: pull their full record and pre-fill the form so
  // staff can confirm. Snapshot the loaded values to flag any later edits as overrides.
  async function selectExisting(customerId: number) {
    setCustomerAction("use_existing"); setExistingId(customerId)
    // Keep Contact open (don't auto-advance) so staff can read the confirm note.
    advanced.current.contact = true
    setOpenSection("contact")
    try {
      const r = await fetch(`/api/leads/customer/${customerId}`)
      const j = await r.json()
      const c = j.customer
      if (!c) return
      setFirstName(c.first_name || ""); setLastName(c.last_name || "")
      setEmail(c.email || ""); setPhone(c.phone || "")
      if (c.street) setStreet(c.street)
      if (c.city) setCity(c.city)
      if (c.state) setStateCode(c.state || "GA")
      if (c.zip) { setZip(c.zip); const o = checkServiceArea(c.zip).office; if (o) setOffice(o) }
      setExistingSnapshot({
        name: c.display_name || `${c.first_name} ${c.last_name}`.trim(),
        fields: { first_name: c.first_name || "", last_name: c.last_name || "", email: c.email || "", phone: c.phone || "" },
      })
    } catch { /* leave fields as-is on fetch failure */ }
  }
  function chooseCreateNew() { setCustomerAction("create_new"); setExistingId(null); setExistingSnapshot(null) }

  // Which contact fields the staffer changed vs. the saved record (override warning).
  const overriddenFields = existingSnapshot
    ? (Object.entries({ first_name: firstName, last_name: lastName, email, phone }) as [string, string][])
        .filter(([k, v]) => (v || "").trim() !== (existingSnapshot.fields[k] || "").trim())
        .map(([k]) => CONTACT_LABEL[k])
    : []

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
                <OptionPills
                  value={office}
                  onChange={(v) => setOffice(v as Office)}
                  disabled={pending}
                  options={OFFICES.map((o) => ({ value: o.id, label: o.label }))}
                />
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
              <Field label="Email"><input name="email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); if (customerAction !== "use_existing") runDedup(e.target.value || phone) }} className={inputCls} disabled={pending} placeholder="email or phone required" /></Field>
              <Field label="Phone"><input name="phone" type="tel" inputMode="tel" value={phone} onChange={(e) => { const f = formatPhone(e.target.value); setPhone(f); if (customerAction !== "use_existing") runDedup(email || f) }} className={inputCls} disabled={pending} placeholder="(555) 123-4567" /></Field>
            </div>
            {matches.length > 0 && (
              <div className="border border-sun/30 bg-sun/10 rounded-md p-3 flex flex-col gap-2 mt-3">
                <div className="text-[12px] text-sun">{matches.length} possible existing customer{matches.length > 1 ? "s" : ""} — attach to one, or create new.</div>
                {matches.map((m) => (
                  <label key={m.customer_id} className="flex items-center gap-2 text-[13px] cursor-pointer">
                    <input type="radio" name="dedup_choice" className="accent-cyan" checked={customerAction === "use_existing" && existingId === m.customer_id}
                      onChange={() => selectExisting(m.customer_id)} />
                    <span className="text-ink">{m.display_name}</span>
                    <span className="text-ink-mute text-xs">{[m.redacted_phone, m.redacted_email].filter(Boolean).join(" · ")}</span>
                    {m.has_qbo && <Pill tone="grass">QBO</Pill>}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                  <input type="radio" name="dedup_choice" className="accent-cyan" checked={customerAction === "create_new"} onChange={chooseCreateNew} />
                  <span className="text-ink-dim">None of these — create a new customer</span>
                </label>
              </div>
            )}
            {customerAction === "use_existing" && existingSnapshot && (
              <div className="border border-cyan/30 bg-cyan/10 rounded-md p-3 mt-3 text-[12px] leading-relaxed">
                <span className="text-cyan font-medium">Loaded {existingSnapshot.name}&apos;s saved info.</span>{" "}
                <span className="text-ink-dim">Confirm their contact above — anything you change here will overwrite their record on file.</span>
                {overriddenFields.length > 0 && (
                  <div className="text-sun mt-1.5">Will overwrite: {overriddenFields.join(", ")}.</div>
                )}
              </div>
            )}
          </Accordion>

          {/* 3. Lead details */}
          <Accordion sectionKey="details" title="Lead details" open={openSection === "details"} complete onToggle={toggle}
            summary={<span className="text-ink-dim truncate">{cap(primaryBody)}{additionalBodies ? " + fountain" : ""} · {VISIT_LABEL[visits]} · {COND_LABEL[poolCondition]}</span>}>
            <div className="flex flex-col gap-3">
              <Field label="Primary body">
                <div className="flex items-center gap-4 flex-wrap">
                  <OptionPills name="primary_body_type" value={primaryBody} disabled={pending}
                    onChange={(v) => setPrimaryBody(v as typeof primaryBody)}
                    options={[{ value: "pool", label: "Pool" }, { value: "spa", label: "Spa" }, { value: "fountain", label: "Fountain" }]} />
                  <label className="flex items-center gap-2 text-[12px] text-ink-dim">
                    <input type="checkbox" name="additional_fountain" checked={fountain} onChange={(e) => setFountain(e.target.checked)} className="accent-cyan" disabled={pending || primaryBody === "fountain"} />
                    Add a fountain (+$10/visit)
                  </label>
                </div>
              </Field>
              <Field label="Visits / week">
                <OptionPills name="visits_per_week" value={visits} disabled={pending}
                  onChange={(v) => setVisits(v as typeof visits)}
                  options={[{ value: "0.5", label: "Bi-weekly" }, { value: "1", label: "Weekly" }, { value: "2", label: "2x per week" }]} />
              </Field>
              <Field label="Pool condition">
                <OptionPills name="pool_condition" value={poolCondition} disabled={pending}
                  onChange={(v) => setPoolCondition(v as typeof poolCondition)}
                  options={[{ value: "good", label: "Good" }, { value: "needs_repair", label: "Needs repair" }, { value: "green_pool", label: "Green pool" }]} />
              </Field>
            </div>
            <Field cls="mt-3" label="Issue / notes"><textarea name="issue_description" value={issue} onChange={(e) => setIssue(e.target.value)} rows={3} className={inputCls} disabled={pending} /></Field>
          </Accordion>
        </div>

        {/* ── Right: quote + submit ────────────────────────────────── */}
        <div className="col-span-1">
          <div className="sticky top-6 flex flex-col gap-4">
            <Card>
              <div className="px-5 pt-4 pb-2 text-[11px] uppercase tracking-[0.12em] text-ink-mute">Estimated monthly</div>
              <div className="px-5 pb-4 text-[13px] flex flex-col">
                <QuoteLine
                  label="Labor"
                  value={`$${quote.laborMonthly}/mo`}
                  sub={`$${quote.perVisit}/visit · ${quote.visitsPerMonth} visits`}
                  note={`Each visit we skim, brush, vacuum as needed, empty the baskets, test + balance the water, and check the equipment. Say: "${VISIT_LABEL[visits].toLowerCase()} service is $${quote.perVisit} a visit, about ${quote.visitsPerMonth} visits a month." Labor is the only part billed up front (the first-month deposit).`}
                />
                <QuoteLine
                  label="Est. chemicals"
                  value={quote.chem ? `$${quote.chem.median}/mo` : "—"}
                  sub={quote.chem ? `range $${quote.chem.low}–$${quote.chem.high}${quote.chem.approximated ? " · approx" : ""}` : "estimate unavailable"}
                  note={quote.chem
                    ? `Chemicals are billed separately, based on what the pool actually uses — so it swings with the season and the pool's condition. Say: "most pools like yours run about $${quote.chem.median} a month in chemicals, a bit more in summer." This is an estimate from our own customer data, not a set charge.`
                    : "Chemical estimate isn't available right now — tell them chemicals are billed separately based on usage."}
                />
                <div className="border-t border-line-soft my-1.5" />
                <QuoteLine
                  emphasize
                  label="Estimated monthly total"
                  value={quote.monthlyTotal ? `$${quote.monthlyTotal.median}` : `$${quote.laborMonthly}+`}
                  sub={quote.monthlyTotal ? `range $${quote.monthlyTotal.low}–$${quote.monthlyTotal.high}` : undefined}
                  note={`Labor plus the estimated chemicals. Say: "you're looking at roughly $${quote.monthlyTotal ? quote.monthlyTotal.median : quote.laborMonthly} a month — billed monthly, cancel anytime, no penalties. The chemical part is an estimate, so some months run a little higher or lower."`}
                />
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
/**
 * One line in the quote panel — collapsed it shows label + value; expanded it
 * reveals a talking-point note so the office person knows what to say on the
 * phone about this line. `emphasize` styles the total row (cyan, larger).
 */
function QuoteLine({
  label, value, sub, note, emphasize = false,
}: { label: string; value: string; sub?: string; note: string; emphasize?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-start justify-between gap-3 text-left group"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <ChevronDown className={`w-3 h-3 text-ink-mute shrink-0 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2} />
          <span className={emphasize ? "text-ink" : "text-ink-mute group-hover:text-ink-dim transition-colors"}>{label}</span>
        </span>
        <span className="text-right shrink-0">
          <span className={emphasize ? "text-cyan text-lg font-display" : "text-ink"}>{value}</span>
          {sub && <span className="block text-ink-mute text-[11px]">{sub}</span>}
        </span>
      </button>
      {open && (
        <p className="text-ink-mute text-[11px] leading-relaxed pl-[18px] pr-1 pt-1.5">{note}</p>
      )}
    </div>
  )
}
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }
