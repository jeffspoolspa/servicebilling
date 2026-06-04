"use client"

import { useActionState, useEffect, useRef, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { AddressAutocomplete, type PickedAddress } from "@/components/form/address-autocomplete"
import { checkServiceArea, calculateQuote } from "@/lib/leads/quote"
import { prettyOffice } from "../ui"
import { createInternalLead, type ActionState } from "../actions"

const empty: ActionState = {}
const inputCls =
  "w-full bg-[#0E1C2A] border border-line rounded-md px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"
const labelCls = "block text-[11px] uppercase tracking-[0.1em] text-ink-mute mb-1"

type Office = "richmond_hill" | "brunswick" | "st_marys"
type DedupMatch = {
  customer_id: number
  display_name: string
  account_type: string | null
  has_qbo: boolean
  redacted_phone: string | null
  redacted_email: string | null
}

export function NewLeadForm() {
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

  const additionalBodies = fountain && primaryBody !== "fountain" ? 1 : 0
  const quote = calculateQuote(primaryBody, additionalBodies, Number(visits))

  function onAddressPicked(a: PickedAddress) {
    setStreet(a.street); setCity(a.city); setStateCode(a.state || "GA"); setZip(a.zip)
    const o = checkServiceArea(a.zip).office
    if (o) setOffice(o)
  }

  // When the ZIP resolves to an office, default the office select to it.
  function onZipBlur() {
    const o = checkServiceArea(zip).office
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
      } catch { setMatches([]) }
      finally { setDedupChecking(false) }
    }, 400)
  }, [])

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])
  useEffect(() => {
    if (state.ok && state.leadId) router.push(`/leads/${state.leadId}` as never)
  }, [state, router])

  return (
    <form action={action}>
      <div className="grid grid-cols-3 gap-5">
        {/* ── Left: the sectioned form ─────────────────────────────── */}
        <div className="col-span-2 flex flex-col gap-5">

          {/* 1. Address */}
          <Card>
            <CardHeader><CardTitle>Address</CardTitle>
              {zip && (area.inArea
                ? <Pill tone="grass" className="ml-auto">In area · {prettyOffice(area.office)}</Pill>
                : <Pill tone="coral" className="ml-auto">Out of service area</Pill>)}
            </CardHeader>
            <div className="p-5 pt-3 flex flex-col gap-3">
              <AddressAutocomplete onPicked={onAddressPicked} className={inputCls} />
              <div className="grid grid-cols-6 gap-3">
                <div className="col-span-6">
                  <label className={labelCls}>Street *</label>
                  <input name="street" value={street} onChange={(e) => setStreet(e.target.value)} className={inputCls} disabled={pending} required />
                </div>
                <div className="col-span-3">
                  <label className={labelCls}>City *</label>
                  <input name="city" value={city} onChange={(e) => setCity(e.target.value)} className={inputCls} disabled={pending} required />
                </div>
                <div className="col-span-1">
                  <label className={labelCls}>State</label>
                  <input name="state" value={stateCode} onChange={(e) => setStateCode(e.target.value)} className={inputCls} disabled={pending} />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>ZIP *</label>
                  <input name="zip" value={zip} onChange={(e) => setZip(e.target.value)} onBlur={onZipBlur} className={inputCls} disabled={pending} required />
                </div>
                <div className="col-span-3">
                  <label className={labelCls}>Office *</label>
                  <select name="office" value={office} onChange={(e) => setOffice(e.target.value as Office)} className={inputCls} disabled={pending}>
                    <option value="richmond_hill">Richmond Hill</option>
                    <option value="brunswick">Brunswick</option>
                    <option value="st_marys">St. Marys</option>
                  </select>
                </div>
              </div>
            </div>
          </Card>

          {/* 2. Contact */}
          <Card>
            <CardHeader><CardTitle>Contact</CardTitle>
              {dedupChecking && <span className="ml-auto text-[11px] text-ink-mute">checking…</span>}
            </CardHeader>
            <div className="p-5 pt-3 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>First name *</label>
                  <input name="first_name" value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputCls} disabled={pending} required />
                </div>
                <div>
                  <label className={labelCls}>Last name *</label>
                  <input name="last_name" value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputCls} disabled={pending} required />
                </div>
                <div>
                  <label className={labelCls}>Email</label>
                  <input name="email" type="email" value={email}
                    onChange={(e) => { setEmail(e.target.value); runDedup(e.target.value || phone) }}
                    className={inputCls} disabled={pending} placeholder="email or phone required" />
                </div>
                <div>
                  <label className={labelCls}>Phone</label>
                  <input name="phone" type="tel" value={phone}
                    onChange={(e) => { setPhone(e.target.value); runDedup(email || e.target.value) }}
                    className={inputCls} disabled={pending} />
                </div>
              </div>

              {matches.length > 0 && (
                <div className="border border-sun/30 bg-sun/10 rounded-md p-3 flex flex-col gap-2">
                  <div className="text-[12px] text-sun">
                    {matches.length} possible existing customer{matches.length > 1 ? "s" : ""} — attach to one, or create new.
                  </div>
                  {matches.map((m) => (
                    <label key={m.customer_id} className="flex items-center gap-2 text-[13px] cursor-pointer">
                      <input type="radio" name="dedup_choice" className="accent-cyan"
                        checked={customerAction === "use_existing" && existingId === m.customer_id}
                        onChange={() => { setCustomerAction("use_existing"); setExistingId(m.customer_id) }} />
                      <span className="text-ink">{m.display_name}</span>
                      <span className="text-ink-mute text-xs">{[m.redacted_phone, m.redacted_email].filter(Boolean).join(" · ")}</span>
                      {m.has_qbo && <Pill tone="grass">QBO</Pill>}
                    </label>
                  ))}
                  <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                    <input type="radio" name="dedup_choice" className="accent-cyan"
                      checked={customerAction === "create_new"}
                      onChange={() => { setCustomerAction("create_new"); setExistingId(null) }} />
                    <span className="text-ink-dim">None of these — create a new customer</span>
                  </label>
                </div>
              )}
            </div>
          </Card>

          {/* 3. Lead details */}
          <Card>
            <CardHeader><CardTitle>Lead details</CardTitle></CardHeader>
            <div className="p-5 pt-3 flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={labelCls}>Primary body</label>
                  <select name="primary_body_type" value={primaryBody} onChange={(e) => setPrimaryBody(e.target.value as typeof primaryBody)} className={inputCls} disabled={pending}>
                    <option value="pool">Pool</option>
                    <option value="spa">Spa</option>
                    <option value="fountain">Fountain</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Visits / week</label>
                  <select name="visits_per_week" value={visits} onChange={(e) => setVisits(e.target.value as typeof visits)} className={inputCls} disabled={pending}>
                    <option value="0.5">Every other week</option>
                    <option value="1">Weekly</option>
                    <option value="2">Twice weekly</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Pool condition</label>
                  <select name="pool_condition" value={poolCondition} onChange={(e) => setPoolCondition(e.target.value as typeof poolCondition)} className={inputCls} disabled={pending}>
                    <option value="good">Good</option>
                    <option value="needs_repair">Needs repair</option>
                    <option value="green_pool">Green pool</option>
                  </select>
                </div>
              </div>
              <label className="flex items-center gap-2 text-[12px] text-ink-dim">
                <input type="checkbox" name="additional_fountain" checked={fountain} onChange={(e) => setFountain(e.target.checked)} className="accent-cyan" disabled={pending || primaryBody === "fountain"} />
                Add a fountain (+$10/visit)
              </label>
              <div>
                <label className={labelCls}>Issue / notes</label>
                <textarea name="issue_description" value={issue} onChange={(e) => setIssue(e.target.value)} rows={3} className={inputCls} disabled={pending} />
              </div>
            </div>
          </Card>
        </div>

        {/* ── Right: live quote + review + submit ──────────────────── */}
        <div className="col-span-1">
          <div className="sticky top-6 flex flex-col gap-4">
            <Card>
              <CardHeader><CardTitle>Quote</CardTitle></CardHeader>
              <div className="p-5 pt-3 text-[13px] flex flex-col gap-2">
                <Row label={`${cap(primaryBody)} maintenance`} value={`$${calculateQuote(primaryBody, 0, Number(visits)).perVisit}`} />
                {additionalBodies > 0 && <Row label="Fountain" value="+$10" />}
                <div className="border-t border-line-soft my-1" />
                <Row label="Per visit" value={`$${quote.perVisit}`} strong />
                <Row label={`First month (${visits === "0.5" ? "2" : visits === "2" ? "8" : "4"} visits)`} value={`$${quote.firstMonthsDeposit}`} strong />
                <p className="text-ink-mute text-[11px] mt-1">Chemicals not included. Computed from the canonical pricing — this is the rate that gets stored.</p>
              </div>
            </Card>

            <Card>
              <CardHeader><CardTitle>Review</CardTitle></CardHeader>
              <div className="p-5 pt-3 text-[13px] flex flex-col gap-1.5">
                <Row label="Office" value={prettyOffice(office)} />
                <Row label="Service area" value={zip ? (area.inArea ? "In area" : "Out of area") : "—"} />
                <Row label="Customer" value={customerAction === "use_existing" ? "Existing (attached)" : customerAction === "create_new" ? "New" : matches.length ? "Possible match — choose" : "New"} />
              </div>
            </Card>

            {/* state-backed hidden fields */}
            <input type="hidden" name="customer_action" value={customerAction} />
            <input type="hidden" name="existing_customer_id" value={existingId ?? ""} />

            {state.error && (
              <div className="text-coral text-[13px] bg-coral/10 border border-coral/20 rounded-md p-3">{state.error}</div>
            )}
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Creating…" : "Create lead"}
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-ink-mute">{label}</span>
      <span className={strong ? "text-ink font-medium" : "text-ink-dim"}>{value}</span>
    </div>
  )
}

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }
