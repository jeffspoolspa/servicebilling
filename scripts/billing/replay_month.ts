/**
 * Replay one month through the billing domain and compare against the proven
 * promise table. Read-only. `npx tsx scripts/billing/replay_month.ts [2026-05-01]`
 *
 * The target: billing_audit.task_billing_periods for the month (May 2026 is
 * locked and reconciled 473/475 exact vs ION) — if the domain reproduces those
 * rows, the rule extraction is correct before anything depends on it.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { BillingMonth, EffectiveHistory, laborPolicyFor, consumablesPolicyFor } from "@/lib/domain/billing"
import type { TaskExpectation, TaskTerms, VisitFact } from "@/lib/domain/billing"

const MONTH = process.argv[2] ?? "2026-05-01"
const monthEnd = (() => {
  const [y, m] = MONTH.split("-").map(Number)
  return `${MONTH.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`
})()

async function fetchAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw new Error(JSON.stringify(error))
    const rows = data as T[]
    out.push(...rows)
    if (rows.length < 1000) return out
  }
}

async function main() {
  const env: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const maint = sb.schema("maintenance")

  type VRow = { id: string; task_id: string; customer_id: number | null; scheduled_date: string; visit_date: string | null; is_serviceable: boolean | null }
  const visits = await fetchAll<VRow>((a, b) =>
    maint.from("visits")
      .select("id, task_id, customer_id, scheduled_date, visit_date, is_serviceable")
      .not("task_id", "is", null)
      .is("ion_deleted_at", null)
      .or(`and(scheduled_date.gte.${MONTH},scheduled_date.lte.${monthEnd}),and(visit_date.gte.${MONTH},visit_date.lte.${monthEnd})`)
      .order("id").range(a, b),
  )
  const visitIds = visits.map((v) => v.id)
  type URow = { id: string; visit_id: string; ion_item_id: string | null; item_name: string | null; quantity: number }
  const usages: URow[] = []
  for (let i = 0; i < visitIds.length; i += 200) {
    usages.push(...await fetchAll<URow>((a, b) =>
      maint.from("consumables_usage").select("id, visit_id, ion_item_id, item_name, quantity")
        .in("visit_id", visitIds.slice(i, i + 200)).order("id").range(a, b)))
  }
  const usagesByVisit = new Map<string, URow[]>()
  for (const u of usages) {
    const l = usagesByVisit.get(u.visit_id)
    if (l) l.push(u)
    else usagesByVisit.set(u.visit_id, [u])
  }

  type TRow = { id: string; customer_id: number | null; billing_method: string | null; consumables_mode: string | null; price_per_visit_cents: number | null; flat_rate_monthly_cents: number | null; status: string | null; starts_on: string | null; ends_on: string | null }
  const tasks = await fetchAll<TRow>((a, b) =>
    maint.from("tasks").select("id, customer_id, billing_method, consumables_mode, price_per_visit_cents, flat_rate_monthly_cents, status, starts_on, ends_on").order("id").range(a, b),
  )
  const terms = new Map<string, TaskTerms>(tasks.map((t) => [t.id, {
    id: t.id, customerId: t.customer_id,
    laborPolicy: laborPolicyFor(t.billing_method),
    consumablesPolicy: consumablesPolicyFor(t.consumables_mode),
    perVisitCents: t.price_per_visit_cents ?? 0,
    flatMonthlyCents: t.flat_rate_monthly_cents ?? 0,
    active: t.status === "active", startsOn: t.starts_on, endsOn: t.ends_on,
  }]))

  type CRow = { ion_item_id: string; unit_price_cents: number | null; valid_from: string; valid_to: string | null }
  const catRows = await fetchAll<CRow>((a, b) =>
    maint.from("consumable_prices").select("ion_item_id, unit_price_cents, valid_from, valid_to").order("ion_item_id").range(a, b))
  const byItem = new Map<string, { from: string; to: string | null; value: number | null }[]>()
  for (const c of catRows) {
    const e = { from: c.valid_from, to: c.valid_to, value: c.unit_price_cents }
    const l = byItem.get(c.ion_item_id)
    if (l) l.push(e); else byItem.set(c.ion_item_id, [e])
  }
  const catalog = new Map([...byItem].map(([id, es]) => [id, new EffectiveHistory(es)]))

  // ---- assemble facts and run the aggregate per customer ----------------
  const facts: VisitFact[] = visits.map((v) => ({
    id: v.id, taskId: v.task_id, customerId: v.customer_id,
    scheduledDate: v.scheduled_date, visitDate: v.visit_date,
    serviceable: v.is_serviceable !== false,
    usages: (usagesByVisit.get(v.id) ?? []).map((u) => ({
      id: u.id, ionItemId: u.ion_item_id, itemName: u.item_name, quantity: Number(u.quantity),
    })),
  }))
  const custOf = (taskId: string, visitCustomer: number | null) =>
    visitCustomer ?? terms.get(taskId)?.customerId ?? 0
  const byCustomer = new Map<number, VisitFact[]>()
  for (const f of facts) {
    const c = custOf(f.taskId, f.customerId)
    const l = byCustomer.get(c)
    if (l) l.push(f)
    else byCustomer.set(c, [f])
  }
  // flat tasks join their customer's month even with zero visits
  for (const t of terms.values()) {
    if (t.laborPolicy.key !== "flat_rate_monthly") continue
    const c = t.customerId ?? 0
    if (!byCustomer.has(c)) byCustomer.set(c, [])
  }

  const expByTask = new Map<string, TaskExpectation>()
  for (const [customerId, custVisits] of byCustomer) {
    const taskIds = new Set(custVisits.map((v) => v.taskId))
    const custTerms = [...terms.values()].filter(
      (t) => taskIds.has(t.id) || (t.laborPolicy.key === "flat_rate_monthly" && (t.customerId ?? 0) === customerId),
    )
    const m = new BillingMonth(customerId, MONTH)
    m.accrue(custVisits, custTerms, catalog)
    for (const e of m.expectations()) expByTask.set(e.taskId, e)
  }
  // flat expectations for tasks with no items surfaced (zero-visit months)
  console.log(`domain: ${expByTask.size} task-months accrued from ${facts.length} visits, ${usages.length} usages`)

  // ---- compare against the promise table --------------------------------
  type PRow = { task_id: string; billable_visit_count: number; expected_labor_cents: number; expected_consumable_cents: number }
  const promises = await fetchAll<PRow>((a, b) =>
    sb.schema("billing_audit").from("task_billing_periods")
      .select("task_id, billable_visit_count, expected_labor_cents, expected_consumable_cents")
      .eq("billing_month", MONTH).order("task_id").range(a, b))

  let laborOk = 0, daysOk = 0, consOk = 0
  const mism: string[] = []
  for (const p of promises) {
    const e = expByTask.get(p.task_id)
    const days = e?.billableDays ?? 0
    const labor = e?.laborCents ?? 0
    const cons = e?.consumableCents ?? 0
    if (labor === p.expected_labor_cents) laborOk++
    if (days === p.billable_visit_count) daysOk++
    if (cons === p.expected_consumable_cents) consOk++
    if (labor !== p.expected_labor_cents || cons !== p.expected_consumable_cents)
      mism.push(`task ${p.task_id.slice(0, 8)}: labor ${labor} vs ${p.expected_labor_cents} · days ${days} vs ${p.billable_visit_count} · cons ${cons} vs ${p.expected_consumable_cents}`)
  }
  const extra = [...expByTask.keys()].filter((t) => !promises.some((p) => p.task_id === t))
  console.log(`\npromise rows for ${MONTH}: ${promises.length}`)
  console.log(`labor exact: ${laborOk}/${promises.length}`)
  console.log(`days  exact: ${daysOk}/${promises.length}`)
  console.log(`cons  exact: ${consOk}/${promises.length}`)
  console.log(`domain task-months not in promises: ${extra.length}`)
  if (mism.length) console.log(`\nfirst mismatches:\n  ${mism.slice(0, 12).join("\n  ")}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
