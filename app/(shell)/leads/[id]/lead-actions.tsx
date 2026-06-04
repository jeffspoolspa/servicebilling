"use client"

import { useActionState } from "react"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  markQuoted,
  addNote,
  sendCardLink,
  setStatus,
  type ActionState,
} from "../actions"

const empty: ActionState = {}
const inputCls =
  "w-full bg-[#0E1C2A] border border-line rounded-md px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"

function Result({ state }: { state: ActionState }) {
  if (state.error) return <p className="text-coral text-xs">{state.error}</p>
  if (state.ok) return <p className="text-grass text-xs">{state.ok}</p>
  return null
}

export function LeadActions({ leadId, status }: { leadId: string; status: string }) {
  return (
    <Card>
      <CardHeader><CardTitle>Actions</CardTitle></CardHeader>
      <div className="p-5 pt-3 flex flex-col gap-5">
        <MarkQuoted leadId={leadId} />
        <SendCardLink leadId={leadId} />
        <SetStatus leadId={leadId} status={status} />
        <AddNote leadId={leadId} />
      </div>
    </Card>
  )
}

function MarkQuoted({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(markQuoted, empty)
  return (
    <form action={action} className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-[0.1em] text-ink-mute">Mark quoted</span>
      <input type="hidden" name="lead_id" value={leadId} />
      <div className="flex gap-2">
        <select name="channel" className={inputCls} defaultValue="email" disabled={pending}>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
          <option value="phone">Phone</option>
        </select>
        <Button type="submit" size="sm" disabled={pending}>{pending ? "…" : "Quote"}</Button>
      </div>
      <Result state={state} />
    </form>
  )
}

function SendCardLink({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(sendCardLink, empty)
  return (
    <form action={action} className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-[0.1em] text-ink-mute">Card on file</span>
      <input type="hidden" name="lead_id" value={leadId} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Creating…" : "Create card-collection link"}
      </Button>
      <Result state={state} />
    </form>
  )
}

function SetStatus({ leadId, status }: { leadId: string; status: string }) {
  const [state, action, pending] = useActionState(setStatus, empty)
  return (
    <form action={action} className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-[0.1em] text-ink-mute">Set status</span>
      <input type="hidden" name="lead_id" value={leadId} />
      <div className="flex gap-2">
        <select name="status" className={inputCls} defaultValue={status} disabled={pending}>
          {["new", "quoted", "accepted", "converted", "expired", "declined", "disqualified"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={pending}>{pending ? "…" : "Apply"}</Button>
      </div>
      <Result state={state} />
    </form>
  )
}

function AddNote({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(addNote, empty)
  return (
    <form action={action} className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-[0.1em] text-ink-mute">Add note</span>
      <input type="hidden" name="lead_id" value={leadId} />
      <textarea name="note" rows={2} className={inputCls} placeholder="Internal note…" disabled={pending} />
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Add note"}</Button>
      <Result state={state} />
    </form>
  )
}
