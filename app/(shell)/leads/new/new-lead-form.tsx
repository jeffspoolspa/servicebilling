"use client"

import { useActionState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { createInternalLead, type ActionState } from "../actions"

const empty: ActionState = {}

const inputCls =
  "w-full bg-[#0E1C2A] border border-line rounded-md px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"
const labelCls = "block text-[11px] uppercase tracking-[0.1em] text-ink-mute mb-1"

export function NewLeadForm() {
  const router = useRouter()
  const [state, action, pending] = useActionState(createInternalLead, empty)

  useEffect(() => {
    if (state.ok && state.leadId) router.push(`/leads/${state.leadId}` as never)
  }, [state, router])

  return (
    <form action={action} className="flex flex-col gap-5">
      <section className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>First name *</label>
          <input name="first_name" className={inputCls} disabled={pending} required />
        </div>
        <div>
          <label className={labelCls}>Last name *</label>
          <input name="last_name" className={inputCls} disabled={pending} required />
        </div>
        <div>
          <label className={labelCls}>Email</label>
          <input name="email" type="email" className={inputCls} disabled={pending} placeholder="email or phone required" />
        </div>
        <div>
          <label className={labelCls}>Phone</label>
          <input name="phone" type="tel" className={inputCls} disabled={pending} />
        </div>
      </section>

      <section className="grid grid-cols-6 gap-3">
        <div className="col-span-6">
          <label className={labelCls}>Street *</label>
          <input name="street" className={inputCls} disabled={pending} required />
        </div>
        <div className="col-span-3">
          <label className={labelCls}>City *</label>
          <input name="city" className={inputCls} disabled={pending} required />
        </div>
        <div className="col-span-1">
          <label className={labelCls}>State</label>
          <input name="state" defaultValue="GA" className={inputCls} disabled={pending} />
        </div>
        <div className="col-span-2">
          <label className={labelCls}>ZIP *</label>
          <input name="zip" className={inputCls} disabled={pending} required />
        </div>
      </section>

      <section className="grid grid-cols-3 gap-3">
        <div>
          <label className={labelCls}>Office *</label>
          <select name="office" className={inputCls} disabled={pending} required defaultValue="brunswick">
            <option value="richmond_hill">Richmond Hill</option>
            <option value="brunswick">Brunswick</option>
            <option value="st_marys">St. Marys</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Visits / week</label>
          <select name="visits_per_week" className={inputCls} disabled={pending} defaultValue="1">
            <option value="0.5">Every other week</option>
            <option value="1">Weekly</option>
            <option value="2">Twice weekly</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Pool condition</label>
          <select name="pool_condition" className={inputCls} disabled={pending} defaultValue="good">
            <option value="good">Good</option>
            <option value="needs_repair">Needs repair</option>
            <option value="green_pool">Green pool</option>
          </select>
        </div>
      </section>

      <div>
        <label className={labelCls}>Issue / notes</label>
        <textarea name="issue_description" rows={3} className={inputCls} disabled={pending} />
      </div>

      <p className="text-[12px] text-ink-mute">
        The per-visit quote is computed automatically, and a matching existing customer is reused.
      </p>

      {state.error && (
        <div className="text-coral text-[13px] bg-coral/10 border border-coral/20 rounded-md p-3">{state.error}</div>
      )}

      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Creating…" : "Create lead"}
        </Button>
      </div>
    </form>
  )
}
