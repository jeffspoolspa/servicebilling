"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { channelLabel } from "../_lib/labels"

/**
 * Log a call. The customer comes from a typeahead over the EXISTING
 * Customers table — this module holds a customer id and nothing else.
 *
 * The first note is required by the domain, not by this form: a ticket with
 * a subject and no account of what was said is the thing everyone regrets
 * three weeks later. If it were blank, .NET would refuse with those words
 * and they would appear below.
 */
const CHANNELS = ["PhoneCall", "Email", "Text", "WalkIn", "Internal"] as const
const PRIORITIES = ["Low", "Medium", "High", "Critical"] as const

interface CustomerHit { qbo_customer_id: string; display_name: string | null }

export function NewTicketSheet(
  { onClose, onCreated }: { onClose: () => void; onCreated: (ticketId: string) => void },
) {
  const router = useRouter()
  const [term, setTerm] = useState("")
  const [hits, setHits] = useState<CustomerHit[]>([])
  const [customer, setCustomer] = useState<CustomerHit | null>(null)
  const [subject, setSubject] = useState("")
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>("PhoneCall")
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("Medium")
  const [firstNote, setFirstNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // debounce: the caller is still talking, no need to query every keystroke
  useEffect(() => {
    if (customer || term.trim().length < 2) { setHits([]); return }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/support/customers?q=${encodeURIComponent(term)}`)
      setHits(res.ok ? await res.json() : [])
    }, 200)
    return () => clearTimeout(timer)
  }, [term, customer])

  const open = async () => {
    if (!customer) return
    setBusy(true); setError(null)
    try {
      const res = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: customer.qbo_customer_id, subject, channel, priority,
          firstNote, openedBy: "carter",
        }),
      })
      if (!res.ok) {
        const failure = await res.json().catch(() => ({ error: `failed (${res.status})` }))
        setError(failure.error ?? `failed (${res.status})`)   // the domain's own words
        return
      }
      const { ticketId } = await res.json()
      router.refresh()          // the queue picks up the new row
      onCreated(ticketId)       // and the ticket opens, ready for the next note
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[85] flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="flex h-full w-[520px] max-w-[94vw] flex-col border-l border-line bg-bg-surface"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center border-b border-line-soft px-5 py-3">
          <span className="text-[14px] font-medium text-ink">Open a ticket</span>
          <span className="flex-1" />
          <button className="text-[11px] text-dim hover:text-ink" onClick={onClose}>Cancel</button>
        </div>

        <div className="flex-1 space-y-3 overflow-auto px-5 py-4">
          {/* ---- who ---- */}
          <div>
            <div className="pb-1 text-[10.5px] uppercase tracking-wide text-ink-mute">Customer</div>
            {customer ? (
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] text-ink">{customer.display_name}</span>
                <button
                  className="text-[10.5px] text-dim hover:text-ink"
                  onClick={() => { setCustomer(null); setTerm("") }}
                >
                  change
                </button>
              </div>
            ) : (
              <>
                <input
                  autoFocus
                  className="w-full rounded-lg border border-line bg-transparent px-2.5 py-1.5 text-[12px] text-ink"
                  placeholder="Start typing a name…"
                  value={term}
                  onChange={(event) => setTerm(event.target.value)}
                />
                {hits.length > 0 && (
                  <div className="mt-1 max-h-48 overflow-auto rounded-lg border border-line">
                    {hits.map((hit) => (
                      <button
                        key={hit.qbo_customer_id}
                        className="block w-full px-2.5 py-1.5 text-left text-[12px] text-ink-dim hover:bg-white/5"
                        onClick={() => setCustomer(hit)}
                      >
                        {hit.display_name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ---- what ---- */}
          <div>
            <div className="pb-1 text-[10.5px] uppercase tracking-wide text-ink-mute">Subject</div>
            <input
              className="w-full rounded-lg border border-line bg-transparent px-2.5 py-1.5 text-[12px] text-ink"
              placeholder="Pump making a noise"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <div className="pb-1 text-[10.5px] uppercase tracking-wide text-ink-mute">Channel</div>
              <select
                className="w-full rounded-lg border border-line bg-transparent px-2 py-1.5 text-[12px] text-ink"
                value={channel}
                onChange={(event) => setChannel(event.target.value as typeof channel)}
              >
                {CHANNELS.map((option) => (
                  <option key={option} value={option}>{channelLabel(option)}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <div className="pb-1 text-[10.5px] uppercase tracking-wide text-ink-mute">Priority</div>
              <select
                className="w-full rounded-lg border border-line bg-transparent px-2 py-1.5 text-[12px] text-ink"
                value={priority}
                onChange={(event) => setPriority(event.target.value as typeof priority)}
              >
                {PRIORITIES.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </div>
          </div>

          <div>
            <div className="pb-1 text-[10.5px] uppercase tracking-wide text-ink-mute">
              What they said
            </div>
            <textarea
              className="w-full rounded-lg border border-line bg-transparent px-2.5 py-1.5 text-[12px] text-ink"
              rows={4}
              placeholder="Called this morning — no heat since the weekend."
              value={firstNote}
              onChange={(event) => setFirstNote(event.target.value)}
            />
          </div>

          {error && (
            <div className="rounded-lg border border-coral/50 bg-coral/10 px-2.5 py-1.5 text-[11.5px] text-coral">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line-soft px-5 py-3">
          <button className="rounded-full border border-line px-3 py-1 text-[11px] text-dim hover:text-ink" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded-full border border-emerald-500/60 bg-emerald-500/25 px-3 py-1 text-[11px]
                       font-medium text-emerald-200 hover:bg-emerald-500/35 disabled:opacity-40"
            disabled={busy || !customer || !subject.trim() || !firstNote.trim()}
            onClick={open}
          >
            Open ticket
          </button>
        </div>
      </div>
    </div>
  )
}
