/**
 * Shadow accrual — does the new model agree with how the month actually
 * billed? Reads only; writes nothing, anywhere.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/shadow_accrue.ts 2026-07-01 [limit]
 *
 * The comparison is per TASK, because that is the grain independent of how
 * either side groups items into documents (the model doc's Phase 1 green
 * light). A disagreement names the task and the money, so it can be worked.
 */

import "./_env"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { SupabaseBillingFacts } from "@/lib/billing/infrastructure/supabase-billing-facts"
import { BillingMonth, priceMonth } from "@/lib/billing/domain"

const AT = new Date().toISOString()

async function main() {
  const month = process.argv[2] ?? "2026-07-01"
  const limit = Number(process.argv[3] ?? "0")
  const sb = createSupabaseAdmin()
  const facts = new SupabaseBillingFacts(sb as unknown as ConstructorParameters<typeof SupabaseBillingFacts>[0])
  const catalog = await facts.prices()

  // The months that already exist, with what the CURRENT accrual billed.
  const { data: monthRows } = await sb.schema("billing").from("billing_months")
    .select("id, customer_id").eq("month", month).range(0, 999) as { data: { id: string; customer_id: number }[] | null }
  const months = (monthRows ?? []).slice(0, limit > 0 ? limit : undefined)

  // CHUNKED, and the error is CHECKED: 489 uuids in one PostgREST in() filter
  // overflows the URL, and a swallowed error here reads as "they billed
  // nothing", which would have looked like a catastrophic disagreement.
  const itemRows: { billing_month_id: string; task_id: string | null; amount_cents: number | null }[] = []
  for (let i = 0; i < months.length; i += 40) {
    const chunk = months.slice(i, i + 40).map((m) => m.id)
    const { data, error } = (await sb.schema("billing").from("billable_items")
      .select("billing_month_id, task_id, amount_cents")
      .in("billing_month_id", chunk).range(0, 9999)) as
      { data: typeof itemRows | null; error: { message: string } | null }
    if (error) throw new Error(`billable_items read failed: ${error.message}`)
    itemRows.push(...(data ?? []))
  }

  const theirsByMonth = new Map<string, Map<string, number>>()
  for (const r of itemRows) {
    if (!r.task_id) continue
    const m = theirsByMonth.get(r.billing_month_id) ?? new Map<string, number>()
    m.set(r.task_id, (m.get(r.task_id) ?? 0) + (r.amount_cents ?? 0))
    theirsByMonth.set(r.billing_month_id, m)
  }

  const tally = { compared: 0, agree: 0, differ: 0, refused: 0, oursCents: 0, theirsCents: 0 }
  const reasons = new Map<string, number>()
  const worst: { customerId: number; taskId: string; ours: number; theirs: number; delta: number }[] = []

  for (const row of months) {
    const [sources, termsList] = await Promise.all([
      facts.sourcesFor(row.customer_id, month),
      facts.termsFor(row.customer_id, month),
    ])
    const bm = BillingMonth.open(row.id, row.customer_id, month)

    for (const terms of termsList) {
      const { items, refused } = priceMonth({ month, terms, sources, catalog, at: AT })
      for (const r of refused) {
        tally.refused++
        const key = r.reason.replace(/"[^"]*"/g, '"…"').replace(/\d{4}-\d{2}-\d{2}/g, "<date>").slice(0, 90)
        reasons.set(key, (reasons.get(key) ?? 0) + 1)
      }
      for (const i of items) bm.claim(i, { claimedByMonthId: null }, AT)
    }

    const ours = new Map<string, number>()
    for (const i of bm.billableItems) ours.set(i.taskId, (ours.get(i.taskId) ?? 0) + i.amountCents)
    const theirs = theirsByMonth.get(row.id) ?? new Map<string, number>()

    for (const taskId of new Set([...ours.keys(), ...theirs.keys()])) {
      const o = ours.get(taskId) ?? 0
      const t = theirs.get(taskId) ?? 0
      tally.compared++
      tally.oursCents += o
      tally.theirsCents += t
      if (Math.abs(o - t) <= 100) { tally.agree++; continue }
      tally.differ++
      worst.push({ customerId: row.customer_id, taskId, ours: o, theirs: t, delta: o - t })
    }
  }

  const pct = (a: number, b: number) => (b === 0 ? "0" : ((a / b) * 100).toFixed(1))
  console.log(`\n=== shadow accrual ${month} — ${months.length} customer-months ===`)
  console.log(`task comparisons : ${tally.compared}`)
  console.log(`agree (<= $1)    : ${tally.agree}  (${pct(tally.agree, tally.compared)}%)`)
  console.log(`differ           : ${tally.differ}  (${pct(tally.differ, tally.compared)}%)`)
  console.log(`ours   total     : $${(tally.oursCents / 100).toFixed(2)}`)
  console.log(`theirs total     : $${(tally.theirsCents / 100).toFixed(2)}`)
  console.log(`delta            : $${((tally.oursCents - tally.theirsCents) / 100).toFixed(2)}`)
  console.log(`priced-refused   : ${tally.refused}`)

  if (reasons.size) {
    console.log(`\nrefusals by reason:`)
    for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${r}`)
  }
  if (worst.length) {
    console.log(`\nlargest disagreements:`)
    for (const w of worst.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 15)) {
      console.log(`  cust ${w.customerId} task ${w.taskId.slice(0, 8)}  ours $${(w.ours / 100).toFixed(2)}  theirs $${(w.theirs / 100).toFixed(2)}  delta $${(w.delta / 100).toFixed(2)}`)
    }
  }
}

main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exit(1) })
