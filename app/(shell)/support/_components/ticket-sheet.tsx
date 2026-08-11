"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Pill } from "@/components/ui/pill"
import type { ActivityEntry, TicketRow } from "../_lib/views"

/**
 * One ticket: the conversation, and what you can do to it.
 *
 * Every action posts to /api/support/* (which forwards to the .NET domain)
 * and then re-reads. No optimistic updates: the whole point of the domain
 * refusing is that the screen shows what IS, not what was asked for.
 */
export function TicketSheet({ ticket, onClose }: { ticket: TicketRow; onClose: () => void }) {
  const router = useRouter()
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null)
  const [note, setNote] = useState("")
  const [resolution, setResolution] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    const res = await fetch(`/api/support/activity/${ticket.ticket_id}`)
    setActivity(res.ok ? await res.json() : [])
  }
  useEffect(() => { void load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ticket.ticket_id])

  /** Post a command, surface the domain's own words when it refuses. */
  const send = async (path: string, body: unknown) => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/support/tickets/${ticket.ticket_id}/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })
      if (!res.ok) {
        const failure = await res.json().catch(() => ({ error: `failed (${res.status})` }))
        setError(failure.error ?? `failed (${res.status})`)   // e.g. "this ticket is already resolved"
        return false
      }
      await load()
      router.refresh()      // the queue row re-reads from the view
      return true
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[80] flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="flex h-full w-[640px] max-w-[94vw] flex-col border-l border-line bg-bg-surface"
        onClick={(event) => event.stopPropagation()}
      >
        {/* ---------------------------------------------- header */}
        <div className="border-b border-line-soft px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-ink">{ticket.subject}</span>
            <Pill tone={ticket.status === "Open" ? "cyan" : "neutral"}>{ticket.status}</Pill>
            <span className="flex-1" />
            <button className="text-[11px] text-dim hover:text-ink" onClick={onClose}>Close</button>
          </div>
          <div className="pt-1 text-[11.5px] text-ink-mute">
            {ticket.customer ?? "(unknown customer)"} · {ticket.channel} · opened by {ticket.opened_by}
            {ticket.resolved_by && ` · resolved by ${ticket.resolved_by}`}
          </div>
        </div>

        {/* ---------------------------------------------- timeline */}
        <div className="flex-1 overflow-auto px-5 py-3">
          {activity === null && <div className="text-[12px] text-ink-mute">Loading…</div>}
          {activity?.map((entry) => (
            <div key={entry.entry_id} className="border-t border-line-soft/40 py-2 first:border-0">
              <div className="flex items-center gap-2 text-[10.5px] text-ink-mute">
                <span>{new Date(entry.at).toLocaleString()}</span>
                <span>{entry.actor}</span>
                {entry.sub_kind !== "Note" && <Pill tone="indigo">{entry.sub_kind}</Pill>}
                {entry.entry === "link" && (
                  <span className="text-ink-dim">linked {entry.target_id}</span>
                )}
              </div>
              {entry.body && (
                <div className="pt-0.5 text-[12px] leading-relaxed text-ink-dim">{entry.body}</div>
              )}
            </div>
          ))}
        </div>

        {/* ---------------------------------------------- actions */}
        <div className="border-t border-line-soft px-5 py-3">
          {error && (
            <div className="mb-2 rounded-lg border border-coral/50 bg-coral/10 px-2.5 py-1.5 text-[11.5px] text-coral">
              {error}
            </div>
          )}

          <textarea
            className="w-full rounded-lg border border-line bg-transparent px-2.5 py-1.5 text-[12px] text-ink"
            rows={2}
            placeholder="Add a note…"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex items-center gap-2 pt-2">
            <button
              className="rounded-full border border-line px-3 py-1 text-[11px] text-dim hover:text-ink disabled:opacity-40"
              disabled={busy || !note.trim()}
              onClick={async () => { if (await send("notes", { text: note, author: "carter" })) setNote("") }}
            >
              Add note
            </button>

            <span className="flex-1" />

            {ticket.status === "Open" ? (
              <>
                <input
                  className="w-56 rounded-lg border border-line bg-transparent px-2 py-1 text-[11.5px] text-ink"
                  placeholder="What was done…"
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                />
                <button
                  className="rounded-full border border-emerald-500/60 bg-emerald-500/25 px-3 py-1 text-[11px]
                             font-medium text-emerald-200 hover:bg-emerald-500/35 disabled:opacity-40"
                  disabled={busy || !resolution.trim()}
                  onClick={() => send("resolve", { resolution, resolvedBy: "carter" })}
                >
                  Resolve
                </button>
              </>
            ) : (
              <button
                className="rounded-full border border-line px-3 py-1 text-[11px] text-dim hover:text-ink disabled:opacity-40"
                disabled={busy || !note.trim()}
                onClick={() => send("reopen", { reason: note, by: "carter" })}
                title="Type the reason in the note box, then reopen"
              >
                Reopen
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
