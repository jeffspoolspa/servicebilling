/**
 * Verify task config DIRECTLY against ION for the tasks billing a month that
 * the active-roster sync cannot see (status <> 'active'), and stamp
 * ion_verified_at. This is the step that catches a rate change made in the
 * same edit as an expiry — the Winters case.
 *
 * `npx tsx scripts/billing/refresh_task_config.ts <YYYY-MM-01> [--apply]`
 * Reports drift by default; --apply writes ION's values onto maintenance.tasks.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { WindmillIonTaskGateway } from "@/lib/infrastructure/billing/ion-task-gateway"

const MONTH = process.argv[2]
const APPLY = process.argv.includes("--apply")
if (!MONTH || !/^\d{4}-\d{2}-01$/.test(MONTH)) {
  console.error("usage: npx tsx scripts/billing/refresh_task_config.ts <YYYY-MM-01> [--apply]")
  process.exit(1)
}

async function main() {
  const env: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const gateway = new WindmillIonTaskGateway(env.WINDMILL_TOKEN)

  // tasks billing this month that the roster sync cannot refresh
  const { data: months } = await sb.schema("billing").from("billing_months").select("id").eq("month", MONTH)
  const monthIds = (months ?? []).map((m: { id: string }) => m.id)
  const taskIds = new Set<string>()
  for (let i = 0; i < monthIds.length; i += 100) {
    const { data: items } = await sb.schema("billing").from("billable_items")
      .select("task_id").in("billing_month_id", monthIds.slice(i, i + 100))
    for (const r of (items ?? []) as { task_id: string }[]) taskIds.add(r.task_id)
  }
  const { data: tasks } = await sb.schema("maintenance").from("tasks")
    .select("id, ion_task_id, customer_id, status, billing_method, consumables_mode, price_per_visit_cents, flat_rate_monthly_cents, ends_on, ion_verified_at")
    .in("id", [...taskIds])
  const stale = ((tasks ?? []) as Record<string, unknown>[]).filter(
    (t) => t.status !== "active" && t.ion_task_id,
  )

  // ION's task form only renders inside a customer context — prime it or 500.
  const custIds = [...new Set(stale.map((t) => t.customer_id).filter(Boolean))] as number[]
  const ionCustOf = new Map<number, string>()
  for (let i = 0; i < custIds.length; i += 200) {
    const { data: cs } = await sb.from("Customers").select("id, ion_cust_id").in("id", custIds.slice(i, i + 200))
    for (const c of (cs ?? []) as { id: number; ion_cust_id: string | null }[])
      if (c.ion_cust_id) ionCustOf.set(c.id, c.ion_cust_id)
  }

  console.log(`${MONTH}: ${taskIds.size} tasks billing · ${stale.length} not on the active roster -> verifying against ION\n`)
  let drifted = 0, verified = 0, failed = 0
  for (const t of stale) {
    const ionTaskId = String(t.ion_task_id)
    try {
      const d = await gateway.detail(ionTaskId, ionCustOf.get(t.customer_id as number) ?? "")
      const oursCents = t.billing_method === "flat_rate_monthly"
        ? (t.flat_rate_monthly_cents as number | null) ?? 0
        : (t.price_per_visit_cents as number | null) ?? 0
      const diffs: string[] = []
      if (d.laborKey !== (t.billing_method ?? "per_visit")) diffs.push(`method ION=${d.laborKey} ours=${t.billing_method}`)
      if (d.consumablesKey !== (t.consumables_mode ?? "listed")) diffs.push(`consumables ION=${d.consumablesKey} ours=${t.consumables_mode}`)
      if (d.priceCents !== null && d.priceCents !== oursCents)
        diffs.push(`price ION=${(d.priceCents / 100).toFixed(2)} ours=${(oursCents / 100).toFixed(2)}`)
      if ((d.endsOn ?? null) !== ((t.ends_on as string | null) ?? null)) diffs.push(`ends ION=${d.endsOn ?? "-"} ours=${t.ends_on ?? "-"}`)

      if (diffs.length) {
        drifted++
        console.log(`  DRIFT ${ionTaskId}: ${diffs.join("; ")}`)
      }
      if (APPLY) {
        const patch: Record<string, unknown> = {
          ion_verified_at: new Date().toISOString(),
          ion_invoice_type: d.invoiceType,
          billing_method: d.laborKey,
          consumables_mode: d.consumablesKey,
          ends_on: d.endsOn,
        }
        if (d.priceCents !== null) {
          if (d.laborKey === "flat_rate_monthly") patch.flat_rate_monthly_cents = d.priceCents
          else patch.price_per_visit_cents = d.priceCents
        }
        const { error: upErr } = await sb.schema("maintenance").from("tasks").update(patch).eq("id", t.id as string)
        if (upErr) throw new Error(upErr.message)
      }
      verified++
    } catch (e) {
      failed++
      console.error(`  FAIL  ${ionTaskId}: ${e instanceof Error ? e.message : e}`)
    }
  }
  console.log(`\nverified ${verified}/${stale.length} · drift ${drifted} · failed ${failed}${APPLY ? " · APPLIED" : " · report only (pass --apply to write)"}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
