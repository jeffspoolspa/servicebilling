/**
 * Surgical capture of the one-off ION tasks behind July's unlinked visits.
 * The general flow (f/ION/capture_nonactive_tasks) is drifted to the old
 * location-centric schema; this does the same job customer-centric: read each
 * task's config from ION, create maintenance.tasks (+ task_terms seed), link
 * the visits that already carry its ion_task_id, then re-accrue.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { WindmillIonTaskGateway } from "@/lib/infrastructure/billing/ion-task-gateway"
import { BillingService } from "@/lib/application/billing/billing-service"
import { SupabaseBillingRepository, type BillingClient } from "@/lib/infrastructure/billing/supabase-billing-repository"

const TARGETS: { ionTaskId: string; customerId: number; ionCustId: string }[] = [
  { ionTaskId: "5987330", customerId: 6873, ionCustId: "2317829" },
  { ionTaskId: "5988433", customerId: 2312, ionCustId: "2527708" },
  { ionTaskId: "5990182", customerId: 3266, ionCustId: "2411629" },
  { ionTaskId: "5995871", customerId: 6429, ionCustId: "2396021" },
  { ionTaskId: "6001181", customerId: 5059, ionCustId: "1126744" },
  { ionTaskId: "6002685", customerId: 963, ionCustId: "2415037" },
  { ionTaskId: "6002692", customerId: 8457, ionCustId: "1128460" },
  { ionTaskId: "6002710", customerId: 6873, ionCustId: "2317829" },
  { ionTaskId: "6007725", customerId: 8078, ionCustId: "2353134" },
  { ionTaskId: "6027999", customerId: 2978, ionCustId: "2493391" },
  { ionTaskId: "6028670", customerId: 7380, ionCustId: "1127893" },
]
const MONTH = "2026-07-01"

async function main() {
  const env: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const gateway = new WindmillIonTaskGateway(env.WINDMILL_TOKEN)
  const service = new BillingService(new SupabaseBillingRepository(sb as unknown as BillingClient))

  for (const t of TARGETS) {
    const { data: existing } = await sb.schema("maintenance").from("tasks").select("id").eq("ion_task_id", t.ionTaskId).maybeSingle()
    let taskId = (existing as { id: string } | null)?.id
    if (!taskId) {
      const d = await gateway.detail(t.ionTaskId, t.ionCustId)
      const { data: ins, error } = await sb.schema("maintenance").from("tasks").insert({
        customer_id: t.customerId, ion_task_id: t.ionTaskId, status: "closed",
        billing_method: d.laborKey, consumables_mode: d.consumablesKey,
        price_per_visit_cents: d.laborKey === "per_visit" ? d.priceCents : null,
        flat_rate_monthly_cents: d.laborKey === "flat_rate_monthly" ? d.priceCents : null,
        starts_on: d.startsOn, ends_on: d.endsOn,
        external_source: "ion", ion_verified_at: new Date().toISOString(), ion_invoice_type: d.invoiceType,
      }).select("id").single()
      if (error) { console.error(`  ${t.ionTaskId}: INSERT failed — ${error.message}`); continue }
      taskId = (ins as { id: string }).id
      const { error: termErr } = await sb.schema("maintenance").from("task_terms").insert({
        task_id: taskId, billing_method: d.laborKey, consumables_mode: d.consumablesKey,
        price_per_visit_cents: d.laborKey === "per_visit" ? d.priceCents : null,
        flat_rate_monthly_cents: d.laborKey === "flat_rate_monthly" ? d.priceCents : null,
        valid_from: "2000-01-01", source: "capture:oneoff-2026-08",
      })
      if (termErr) { console.error(`  ${t.ionTaskId}: terms failed — ${termErr.message}`); continue }
      console.log(`  created ${t.ionTaskId}: ${d.invoiceType} price=${d.priceCents} ${d.startsOn}..${d.endsOn}`)
    }
    const { data: linked, error: linkErr } = await sb.schema("maintenance").from("visits")
      .update({ task_id: taskId, customer_id: t.customerId })
      .eq("ion_task_id", t.ionTaskId).is("task_id", null).select("id")
    if (linkErr) console.error(`  ${t.ionTaskId}: link failed — ${linkErr.message}`)
    else console.log(`  linked ${(linked ?? []).length} visits to ${t.ionTaskId}`)
  }

  // NAUGLE: the task exists and is linked; only its customer is missing.
  await sb.schema("maintenance").from("tasks").update({ customer_id: 1014636 }).eq("ion_task_id", "5995135").is("customer_id", null)
  const { data: ntask } = await sb.schema("maintenance").from("tasks").select("id").eq("ion_task_id", "5995135").single()
  await sb.schema("maintenance").from("visits").update({ customer_id: 1014636 }).eq("task_id", (ntask as { id: string }).id).is("customer_id", null)
  console.log("  NAUGLE customer set")

  const customers = [...new Set([...TARGETS.map((t) => t.customerId), 1014636])]
  console.log(`re-accruing ${customers.length} customers...`)
  for (const c of customers) {
    const r = await service.accrueMonth(c, MONTH)
    console.log(`  ${c}: ${r.items} items, expected $${(r.expectedTotalCents / 100).toFixed(2)}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
