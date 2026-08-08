/**
 * Reclassify the backfilled agreements' Basis (RULED 2026-08-08): the
 * bootstrap minted everything { customer_contract } as a placeholder; this
 * pass gives each agreement its real program and turns QC / green-pool work
 * on customers with an active maintenance agreement into riders.
 *
 * Program source: the stored translation's serviceTypeId, resolved to its
 * label via maintenance.tasks.external_data (the pre-program translations
 * did not retain the label; new translations carry `program` directly).
 *
 * Idempotent: an agreement whose basis already matches is skipped.
 *
 *   npx tsx scripts/agreements/reclassify-basis.ts
 */

import { createClient } from "@supabase/supabase-js"
import { programOf, type Program } from "../../lib/external/ion/task-translation"
import { classifyBasis } from "../../lib/agreements/application/classify-basis"
import type { Basis } from "../../lib/agreements/domain/service-agreement/basis"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const agr = createClient(URL_, KEY, { db: { schema: "agreements" } })
const maint = createClient(URL_, KEY, { db: { schema: "maintenance" } })

async function all<T>(q: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw error
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) return out
  }
}

async function main() {
  const agreements = await all<{ id: string; customer_id: string; basis: Basis; status: string }>((f, t) =>
    agr.from("service_agreements").select("id, customer_id, basis, status").range(f, t),
  )
  const incs = await all<{ agreement_id: string; ion_task_id: string }>((f, t) =>
    agr.from("ion_incarnations").select("agreement_id, ion_task_id").is("to_at", null).range(f, t),
  )
  const ionTaskOf = new Map(incs.map((i) => [i.agreement_id, i.ion_task_id]))

  const translations = await all<{ ion_task_id: string; observed_at: string; translation: { billing: { inputs: { serviceTypeId: string } } } }>(
    (f, t) => agr.from("intake_translations").select("ion_task_id, observed_at, translation").range(f, t),
  )
  const latestByTask = new Map<string, (typeof translations)[number]>()
  for (const tr of translations) {
    const cur = latestByTask.get(tr.ion_task_id)
    if (!cur || tr.observed_at > cur.observed_at) latestByTask.set(tr.ion_task_id, tr)
  }

  // serviceTypeId -> label, from the tasks blob (pre-program translations kept only the id)
  const tasks = await all<{ ion_task_id: string; external_data: { service_type?: string } | null }>((f, t) =>
    maint.from("tasks").select("ion_task_id, external_data").not("ion_task_id", "is", null).range(f, t),
  )
  const labelOfServiceType = new Map<string, string>()
  for (const t of tasks) {
    const tr = latestByTask.get(t.ion_task_id)
    const label = t.external_data?.service_type
    if (tr && label) labelOfServiceType.set(tr.translation.billing.inputs.serviceTypeId, label)
  }

  // program per agreement
  const programFor = new Map<string, Program>()
  const unmapped: string[] = []
  for (const a of agreements) {
    const ionTask = ionTaskOf.get(a.id)
    const tr = ionTask ? latestByTask.get(ionTask) : undefined
    const label = tr ? labelOfServiceType.get(tr.translation.billing.inputs.serviceTypeId) : undefined
    const program = label ? programOf(label) : null
    if (!program) { unmapped.push(`${ionTask ?? a.id}: ${label ?? "(no label found)"}`); continue }
    programFor.set(a.id, program)
  }

  // host lookup: the customer's active maintenance agreement (post-classification programs)
  const hosts = {
    async activeMaintenanceAgreement(customerId: string) {
      const host = agreements.find(
        (a) => a.customer_id === customerId && a.status === "active" && programFor.get(a.id) === "maintenance",
      )
      return host ? { id: host.id } : null
    },
  }

  const stats = { updated: 0, unchanged: 0, riders: 0, unmapped: unmapped.length }
  const events: object[] = []
  const now = new Date().toISOString()
  for (const a of agreements) {
    const program = programFor.get(a.id)
    if (!program) continue
    const basis = await classifyBasis(program, a.customer_id, hosts)
    if (JSON.stringify(basis) === JSON.stringify(a.basis)) { stats.unchanged++; continue }
    const { error } = await agr.from("service_agreements")
      .update({ basis: basis as object, updated_at: now }).eq("id", a.id)
    if (error) throw error
    stats.updated++
    if (basis.kind === "rider") stats.riders++
    events.push({
      aggregate: "agreement", aggregate_id: a.id, type: "agreement_basis_set",
      actor: "system", occurred_at: now,
      participants: [
        `agreement:${a.id}`, `customer:${a.customer_id}`, `ion_task:${ionTaskOf.get(a.id) ?? "unknown"}`,
        ...(basis.kind === "rider" ? [`agreement:${basis.riderOf}`] : []),
      ],
      payload: { before: a.basis, after: basis, source: "reclassify_basis" },
    })
  }
  if (events.length) {
    const { error } = await maint.from("events").insert(events)
    if (error) throw error
  }

  console.log("=== RECLASSIFY COMPLETE ===")
  console.log(stats)
  if (unmapped.length) {
    console.log("\nunmapped (no service-type label found — investigate):")
    for (const u of unmapped.slice(0, 20)) console.log(`  ${u}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
