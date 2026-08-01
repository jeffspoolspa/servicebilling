/**
 * The phase-1 gate: our billable items summed BY TASK vs ION's per-task
 * invoice facts (billing_audit.ion_task_transactions — Carter pulls the
 * report via the ION transactions pull; a task's supplemental invoices
 * aggregate). Read-only. `npx tsx scripts/billing/reconcile_ion.ts <YYYY-MM-01>`
 *
 * The comparison never involves our invoice grouping — items by task
 * (labor at task rate, consumables round-once on summed qty) against ION's
 * invoice total per task (docs/model/billing.html).
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"

const MONTH = process.argv[2]
if (!MONTH || !/^\d{4}-\d{2}-01$/.test(MONTH)) {
  console.error("usage: npx tsx scripts/billing/reconcile_ion.ts <YYYY-MM-01>")
  process.exit(1)
}

async function main() {
  const env: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

  async function all<T>(mk: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
    const out: T[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await mk(from, from + 999)
      if (error) throw new Error(error.message)
      const rows = data as T[]
      out.push(...rows)
      if (rows.length < 1000) return out
    }
  }

  // our items, rolled up per task in the builder's arithmetic
  type IRow = { task_id: string; kind: string; item_name: string | null; qty: number; unit_price_cents: number | null; amount_cents: number | null; billing_month_id: string }
  const monthIds = await all<{ id: string }>((a, b) =>
    sb.schema("billing").from("billing_months").select("id").eq("month", MONTH).order("id").range(a, b))
  const items: IRow[] = []
  for (let i = 0; i < monthIds.length; i += 100) {
    items.push(...await all<IRow>((a, b) =>
      sb.schema("billing").from("billable_items")
        .select("task_id, kind, item_name, qty, unit_price_cents, amount_cents, billing_month_id")
        .in("billing_month_id", monthIds.slice(i, i + 100).map((m) => m.id)).order("id").range(a, b)))
  }
  const ours = new Map<string, { labor: number; consByItem: Map<string, { qty: number; unit: number | null }> }>()
  for (const it of items) {
    let t = ours.get(it.task_id)
    if (!t) { t = { labor: 0, consByItem: new Map() }; ours.set(it.task_id, t) }
    if (it.kind === "labor") t.labor += it.amount_cents ?? 0
    else {
      const name = it.item_name ?? "?"
      const held = t.consByItem.get(name)
      if (held) { held.qty += Number(it.qty); if (held.unit === null) held.unit = it.unit_price_cents }
      else t.consByItem.set(name, { qty: Number(it.qty), unit: it.unit_price_cents })
    }
  }
  const ourTotal = (t: { labor: number; consByItem: Map<string, { qty: number; unit: number | null }> }) => {
    let cons = 0
    for (const { qty, unit } of t.consByItem.values()) if (unit !== null) cons += Math.round(qty * unit)
    return t.labor + cons
  }

  // ION facts: aggregate per task (supplemental invoices sum)
  type TRow = { ion_task_id: string; amt_cents: number; customer: string | null }
  const ion = await all<TRow>((a, b) =>
    sb.schema("billing_audit").from("ion_task_transactions")
      .select("ion_task_id, amt_cents, customer").eq("month", MONTH).order("transaction_id").range(a, b))
  const ionByTask = new Map<string, { amt: number; customer: string | null }>()
  for (const r of ion) {
    const held = ionByTask.get(r.ion_task_id)
    if (held) held.amt += r.amt_cents
    else ionByTask.set(r.ion_task_id, { amt: r.amt_cents, customer: r.customer })
  }

  // bridge our task uuids -> ion_task_id
  const taskIds = [...ours.keys()]
  const bridge = new Map<string, string>()
  for (let i = 0; i < taskIds.length; i += 200) {
    for (const t of await all<{ id: string; ion_task_id: string | null }>((a, b) =>
      sb.schema("maintenance").from("tasks").select("id, ion_task_id").in("id", taskIds.slice(i, i + 200)).order("id").range(a, b)))
      if (t.ion_task_id) bridge.set(t.id, t.ion_task_id)
  }

  const TOL = 100 // $1, the established labor tolerance
  let exact = 0, within = 0, mismatch = 0, oursOnly = 0
  const bad: string[] = []
  const seenIon = new Set<string>()
  for (const [taskId, t] of ours) {
    const ionId = bridge.get(taskId)
    const fact = ionId ? ionByTask.get(ionId) : undefined
    const total = ourTotal(t)
    if (!fact) {
      if (total > 0) oursOnly++
      continue
    }
    seenIon.add(ionId!)
    const d = total - fact.amt
    if (d === 0) exact++
    else if (Math.abs(d) <= TOL) within++
    else {
      mismatch++
      bad.push(`task ${ionId}  ours ${(total / 100).toFixed(2)}  ion ${(fact.amt / 100).toFixed(2)}  diff ${(d / 100).toFixed(2)}  ${fact.customer ?? ""}`)
    }
  }
  const ionOnly = [...ionByTask.keys()].filter((k) => !seenIon.has(k))
  console.log(`ION tasks for ${MONTH}: ${ionByTask.size} · ours: ${ours.size}`)
  console.log(`exact: ${exact} · within $1: ${within} · MISMATCH: ${mismatch}`)
  console.log(`ours-with-no-ION-invoice: ${oursOnly} · ION-with-no-items: ${ionOnly.length}`)
  if (bad.length) console.log(`\nmismatches:\n  ${bad.slice(0, 25).join("\n  ")}`)
  if (ionOnly.length) console.log(`\nION-only tasks (first 10): ${ionOnly.slice(0, 10).join(", ")}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
