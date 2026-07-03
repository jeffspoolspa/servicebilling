"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

/**
 * Roster management for the Autopay tab: enroll a maintenance customer
 * (searchable native datalist of customers with recurring tasks not already
 * enrolled), choose which of their ACTIVE payment methods on file the charge
 * hits, change it later, or remove (soft — re-adding reactivates history).
 */

interface Candidate {
  qbo_customer_id: string
  display_name: string
}

interface Pm {
  id: string
  type: string | null
  card_brand: string | null
  last_four: string | null
  is_default: boolean | null
}

function pmLabel(pm: Pm): string {
  const brand = pm.type?.toLowerCase().includes("bank")
    ? `ACH ${pm.card_brand ?? ""}`.trim()
    : (pm.card_brand ?? "card")
  return `${brand} ····${pm.last_four ?? "?"}${pm.is_default ? " (default)" : ""}`
}

async function post(body: Record<string, unknown>): Promise<string | null> {
  const r = await fetch("/api/maintenance-billing/autopay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (r.ok) return null
  const j = await r.json().catch(() => ({}))
  return j.error ?? `HTTP ${r.status}`
}

async function fetchPms(qboCustomerId: string): Promise<Pm[]> {
  const r = await fetch(`/api/maintenance-billing/autopay?pms_for=${qboCustomerId}`)
  if (!r.ok) return []
  const j = await r.json()
  return j.payment_methods ?? []
}

export function AutopayAdd({ candidates }: { candidates: Candidate[] }) {
  const router = useRouter()
  const [name, setName] = useState("")
  const [pms, setPms] = useState<Pm[] | null>(null)
  const [pmId, setPmId] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const picked = candidates.find((c) => c.display_name === name)

  async function onPick(v: string) {
    setName(v)
    setPms(null)
    setPmId("")
    setMsg(null)
    const c = candidates.find((x) => x.display_name === v)
    if (!c) return
    const list = await fetchPms(c.qbo_customer_id)
    setPms(list)
    setPmId(list[0]?.id ?? "")
    if (list.length === 0) setMsg("No active payment methods on file — collect a card first.")
  }

  async function add() {
    if (!picked || !pmId) return
    setBusy(true)
    setMsg(null)
    const err = await post({
      action: "add",
      qbo_customer_id: picked.qbo_customer_id,
      payment_method_id: pmId,
    })
    setBusy(false)
    if (err) setMsg(err)
    else {
      setName("")
      setPms(null)
      router.refresh()
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input
        list="autopay-candidates"
        value={name}
        onChange={(e) => onPick(e.target.value)}
        placeholder="Add customer…"
        className="bg-bg-elev border border-line rounded-md px-2.5 py-1.5 text-[12px] w-64 placeholder:text-ink-mute/60 focus:outline-none focus:border-cyan/40"
      />
      <datalist id="autopay-candidates">
        {candidates.map((c) => (
          <option key={c.qbo_customer_id} value={c.display_name} />
        ))}
      </datalist>
      {picked && pms && pms.length > 0 && (
        <select
          value={pmId}
          onChange={(e) => setPmId(e.target.value)}
          className="bg-bg-elev border border-line rounded-md px-2.5 py-1.5 text-[12px] focus:outline-none"
        >
          {pms.map((pm) => (
            <option key={pm.id} value={pm.id}>
              {pmLabel(pm)}
            </option>
          ))}
        </select>
      )}
      {picked && pms && pms.length > 0 && (
        <button
          onClick={add}
          disabled={busy || !pmId}
          className="px-3 py-1.5 text-[12px] font-medium rounded border border-teal/30 text-teal bg-teal/10 hover:bg-teal/20 disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add to autopay"}
        </button>
      )}
      {msg && <span className="text-[11px] text-coral">{msg}</span>}
    </div>
  )
}

export function RosterRowActions({ qboCustomerId }: { qboCustomerId: string }) {
  const router = useRouter()
  const [pms, setPms] = useState<Pm[] | null>(null)
  const [pmId, setPmId] = useState("")
  const [busy, setBusy] = useState(false)

  async function startEdit() {
    const list = await fetchPms(qboCustomerId)
    setPms(list)
    setPmId(list[0]?.id ?? "")
  }

  async function savePm() {
    setBusy(true)
    const err = await post({
      action: "set_pm",
      qbo_customer_id: qboCustomerId,
      payment_method_id: pmId,
    })
    setBusy(false)
    if (!err) {
      setPms(null)
      router.refresh()
    }
  }

  async function remove() {
    if (!window.confirm("Remove this customer from autopay? They will get invoice emails instead."))
      return
    setBusy(true)
    const err = await post({ action: "remove", qbo_customer_id: qboCustomerId })
    setBusy(false)
    if (!err) router.refresh()
  }

  if (pms) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <select
          value={pmId}
          onChange={(e) => setPmId(e.target.value)}
          className="bg-bg-elev border border-line rounded px-1.5 py-0.5 text-[11px] focus:outline-none"
        >
          {pms.map((pm) => (
            <option key={pm.id} value={pm.id}>
              {pmLabel(pm)}
            </option>
          ))}
        </select>
        <button
          onClick={savePm}
          disabled={busy || !pmId}
          className="text-[11px] text-teal hover:underline disabled:opacity-50"
        >
          save
        </button>
        <button onClick={() => setPms(null)} className="text-[11px] text-ink-mute hover:text-ink">
          cancel
        </button>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={startEdit}
        disabled={busy}
        className="text-[11px] text-ink-mute hover:text-cyan"
        title="Change payment method"
      >
        change
      </button>
      <button
        onClick={remove}
        disabled={busy}
        className="text-[11px] text-ink-mute hover:text-coral"
        title="Remove from autopay"
      >
        remove
      </button>
    </span>
  )
}
