/**
 * The agreements backfill: refresh every task we hold, write CLEAN
 * agreements from ION's own forms (RULED 2026-08-08) — and, for free, the
 * population-scale test of the translation workflow plus the Deen scan
 * (translation vs mirror disagreements).
 *
 *   roster (mirror) → get_task_forms_batch (chunks, one warm session)
 *   → ionTaskFormFrom → translateTask → intake ledger (ok | quarantine)
 *   → mint agreement (v1 terms, open incarnation, provenance reflection)
 *   → agreement_opened fact (maintenance.events, participants rule)
 *
 * Idempotent by construction: a task with an OPEN incarnation is skipped
 * (unique index enforces it); re-runs converge. Bootstrap writes go
 * through supabase-js (no pg transactions in the app env — the one-breath
 * discipline arrives with the worker tier; the bootstrap compensates by
 * being level-triggered and re-runnable, and nothing depends on these
 * rows mid-write).
 *
 *   npx tsx scripts/agreements/backfill-refresh.ts [--limit N] [--chunk N]
 */

import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { ionTaskFormFrom, translateTask, type TaskTranslation } from "../../lib/external/ion/task-translation"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const maint = createClient(URL_, KEY, { db: { schema: "maintenance" } })
const agr = createClient(URL_, KEY, { db: { schema: "agreements" } })
const pub = createClient(URL_, KEY)

const WM_API = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const WM_AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` }

const argNum = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? Number(process.argv[i + 1]) : dflt
}

async function runBatchJob(tasks: { ionTaskId: string; ionCustId: string }[]): Promise<any[]> {
  const r = await fetch(`${WM_API}/jobs/run/p/f/ION/api/get_task_forms_batch`, {
    method: "POST", headers: { ...WM_AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ tasks }),
  })
  const jobId = (await r.text()).replace(/"/g, "")
  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 5000))
    const jr = await fetch(`${WM_API}/jobs_u/completed/get_result_maybe/${jobId}`, { headers: WM_AUTH })
    const d = await jr.json()
    if (d.completed) {
      if (!d.success) throw new Error(`batch job failed: ${JSON.stringify(d.result).slice(0, 300)}`)
      return d.result.results
    }
  }
  throw new Error(`batch job ${jobId} timed out`)
}

async function main() {
  const limit = argNum("--limit", 100000)
  const chunkSize = argNum("--chunk", 25)
  const observedAt = new Date().toISOString()

  // roster: active-ish tasks with ION identity + customer for form priming
  const { data: roster, error: rosterErr } = await maint
    .from("v_task_schedules_with_context")
    .select("task_id, ion_task_id, qbo_customer_id, customer_id, frequency")
    .eq("active", true)
  if (rosterErr) throw rosterErr
  const { data: custs } = await pub.from("Customers").select("id, ion_cust_id, qbo_customer_id")
  const ionCustOf = new Map((custs ?? []).map((c) => [c.id, c.ion_cust_id]))

  // one entry per ION task; skip tasks already holding an OPEN incarnation
  const { data: openInc } = await agr.from("ion_incarnations").select("ion_task_id").is("to_at", null)
  const already = new Set((openInc ?? []).map((r) => r.ion_task_id))

  const seen = new Set<string>()
  const targets: { ionTaskId: string; ionCustId: string; taskId: string; customerId: string; mirrorSlots: number; mirrorFreq: string }[] = []
  for (const r of roster ?? []) {
    if (!r.ion_task_id || seen.has(r.ion_task_id) || already.has(r.ion_task_id)) {
      if (r.ion_task_id && seen.has(r.ion_task_id)) {
        const t = targets.find((t) => t.ionTaskId === r.ion_task_id)
        if (t) t.mirrorSlots += 1
      }
      if (r.ion_task_id) seen.add(r.ion_task_id)
      continue
    }
    seen.add(r.ion_task_id)
    const ionCust = ionCustOf.get(r.customer_id)
    if (!ionCust) continue
    targets.push({
      ionTaskId: String(r.ion_task_id), ionCustId: String(ionCust), taskId: r.task_id,
      customerId: String(r.qbo_customer_id ?? ""), mirrorSlots: 1, mirrorFreq: r.frequency ?? "",
    })
  }
  const work = targets.slice(0, limit)
  console.log(`roster: ${targets.length} tasks to refresh (open incarnations skipped: ${already.size}) — running ${work.length}`)

  const stats = { translated: 0, opened: 0, quarantined: 0, disagreements: 0 }
  const disagreements: string[] = []
  const failures = new Map<string, number>()

  for (let i = 0; i < work.length; i += chunkSize) {
    const chunk = work.slice(i, i + chunkSize)
    const results = await runBatchJob(chunk.map((t) => ({ ionTaskId: t.ionTaskId, ionCustId: t.ionCustId })))
    const events: object[] = []

    for (const res of results) {
      const target = chunk.find((t) => t.ionTaskId === res.ionTaskId)!
      if (!res.ok) {
        await agr.from("intake_failures").insert({ ion_task_id: res.ionTaskId, observed_at: observedAt, failed: `fetch: ${res.error}`, raw: {} })
        stats.quarantined++
        failures.set(`fetch:${res.error.slice(0, 60)}`, (failures.get(`fetch:${res.error.slice(0, 60)}`) ?? 0) + 1)
        continue
      }
      const intake = ionTaskFormFrom({ fields: res.fields, detail: res.detail })
      if (!intake.ok) {
        await agr.from("intake_failures").insert({ ion_task_id: res.ionTaskId, observed_at: observedAt, failed: intake.failed, raw: intake.raw })
        stats.quarantined++
        failures.set(intake.failed.slice(0, 60), (failures.get(intake.failed.slice(0, 60)) ?? 0) + 1)
        continue
      }
      // catalog port not wired yet: itemcost-null tasks record inputs, resolve null (honest)
      const tr = translateTask(intake.value, () => null)
      if (!tr.ok) {
        await agr.from("intake_failures").insert({ ion_task_id: res.ionTaskId, observed_at: observedAt, failed: tr.failed, raw: tr.raw })
        stats.quarantined++
        failures.set(tr.failed.slice(0, 60), (failures.get(tr.failed.slice(0, 60)) ?? 0) + 1)
        continue
      }
      const t: TaskTranslation = tr.value
      const { error: eIntake } = await agr.from("intake_translations").upsert(
        { ion_task_id: t.ionTaskId, observed_at: observedAt, translation: t as object, raw_delta: {} },
        { onConflict: "ion_task_id,observed_at" },
      )
      if (eIntake) throw new Error(`intake write failed (${t.ionTaskId}): ${eIntake.message}`)
      stats.translated++

      // the Deen scan, free: translation vs mirror
      const obsDays = t.schedule.stops.length
      if (obsDays !== target.mirrorSlots) {
        stats.disagreements++
        disagreements.push(`${t.ionTaskId}: ION says ${obsDays} day(s), mirror holds ${target.mirrorSlots} active slot(s) [mirror freq: ${target.mirrorFreq}]`)
      }

      // mint the clean agreement (provenance reflection)
      const agreementId = randomUUID()
      const { error: e1 } = await agr.from("service_agreements").insert({
        id: agreementId, customer_id: target.customerId || target.taskId,
        basis: { kind: "customer_contract" }, status: "active",
      })
      if (e1) { console.error(`agreement insert ${t.ionTaskId}: ${e1.message}`); continue }
      await agr.from("terms_versions").insert({
        agreement_id: agreementId, version: 1, pattern: t.schedule.frequency as object,
        billing: t.billing as object, period: t.schedule.period as object,
        from_at: observedAt, cause: "opened",
      })
      await agr.from("ion_incarnations").insert({
        agreement_id: agreementId, ion_task_id: t.ionTaskId, from_at: observedAt, cause: "opened",
      })
      events.push({
        aggregate: "agreement", aggregate_id: agreementId, type: "agreement_opened",
        actor: "system", occurred_at: observedAt,
        participants: [`agreement:${agreementId}`, `customer:${target.customerId}`, `ion_task:${t.ionTaskId}`],
        payload: { basis: { kind: "customer_contract" }, terms: { pattern: t.schedule.frequency, billing: t.billing, period: t.schedule.period }, provenance: "reflection", source: "backfill_refresh" },
      })
      stats.opened++
    }
    if (events.length) await maint.from("events").insert(events)
    console.log(`chunk ${1 + i / chunkSize}/${Math.ceil(work.length / chunkSize)}: translated=${stats.translated} opened=${stats.opened} quarantined=${stats.quarantined} disagreements=${stats.disagreements}`)
  }

  console.log("\n=== BACKFILL COMPLETE ===")
  console.log(stats)
  console.log("\nfailure classes:")
  for (const [k, n] of [...failures].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${k}`)
  console.log(`\nmirror disagreements (the Deen cohort): ${disagreements.length}`)
  for (const d of disagreements.slice(0, 30)) console.log(`  ${d}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
