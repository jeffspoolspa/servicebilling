/**
 * SweepIonTasks harness — read ION's active-task report, set-difference it
 * against the book, report every divergence. Dry by default; --apply arms
 * the remedies (each one runs through EditAgreement, the same sentence a
 * publish uses).
 *
 *   npx tsx scripts/agreements/sweep.ts [--apply] [--refresh-report]
 *
 * --refresh-report re-scrapes ION first (slow, one pass over the whole
 * population); without it the sweep uses the last scrape and SAYS how old
 * it is — a stale report is exactly how 36 agreements rotted unseen.
 */
import { createClient } from "@supabase/supabase-js"
import { sweepIonTasks, type SweepDeps } from "../../lib/agreements/application/sweep-ion-tasks"
import { repoAdapter, intakeAdapter, quotasAdapter, factsAdapter } from "../../lib/agreements/adapters/supabase"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const agr = createClient(URL_, KEY, { db: { schema: "agreements" } })
const ion = createClient(URL_, KEY, { db: { schema: "ion" } })
const WM = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const H = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}`, "Content-Type": "application/json" }

async function all<T>(q: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw error
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) return out
  }
}

async function refreshReport() {
  const r = await fetch(`${WM}/jobs/run/f/f/ION/recurring_tasks`, { method: "POST", headers: H, body: "{}" })
  const job = (await r.text()).replace(/"/g, "")
  console.log(`re-scraping ION's active tasks (job ${job}) — this takes a few minutes`)
  for (let i = 0; i < 200; i++) {
    await new Promise((s) => setTimeout(s, 5000))
    const d = await (await fetch(`${WM}/jobs_u/completed/get_result_maybe/${job}`, { headers: H })).json()
    if (d.completed) {
      if (!d.success) throw new Error(`report scrape failed: ${JSON.stringify(d.result).slice(0, 200)}`)
      return
    }
  }
  throw new Error("report scrape timed out")
}

async function main() {
  const apply = process.argv.includes("--apply")
  if (process.argv.includes("--refresh-report")) await refreshReport()

  const rows = await all<{ ion_task_id: string; ion_cust_id: string; customer_name: string | null; synced_at: string }>(
    (f, t) => ion.from("recurring_tasks").select("ion_task_id, ion_cust_id, customer_name, synced_at").range(f, t),
  )
  const asOf = rows.map((r) => r.synced_at).sort().pop() ?? "never"
  const ageDays = Math.round((Date.now() - Date.parse(asOf)) / 86_400_000)
  console.log(`ION active-task report: ${rows.length} tasks, scraped ${asOf.slice(0, 10)} (${ageDays}d old)`)
  if (ageDays > 1) console.log(`  WARNING: a stale report reports stale divergences — re-run with --refresh-report`)

  const deps: SweepDeps = {
    repo: repoAdapter(), intake: intakeAdapter, quotas: quotasAdapter, facts: factsAdapter,
    activeTasks: async () => rows.map((r) => ({
      ionTaskId: String(r.ion_task_id), ionCustId: String(r.ion_cust_id), customerName: r.customer_name ?? undefined,
    })),
    bookSlices: async () => {
      const incs = await all<{ ion_task_id: string; agreement_id: string }>((f, t) =>
        agr.from("ion_incarnations").select("ion_task_id, agreement_id").is("to_at", null).range(f, t))
      const sas = await all<{ id: string; customer_id: string }>((f, t) =>
        agr.from("service_agreements").select("id, customer_id").eq("status", "active").range(f, t))
      const custOf = new Map(sas.map((s) => [s.id, s.customer_id]))
      const ionCustOf = new Map(rows.map((r) => [String(r.ion_task_id), String(r.ion_cust_id)]))
      return incs.filter((i) => custOf.has(i.agreement_id)).map((i) => ({
        ionTaskId: String(i.ion_task_id), agreementId: i.agreement_id,
        customerId: custOf.get(i.agreement_id)!, ionCustId: ionCustOf.get(String(i.ion_task_id)) ?? null,
      }))
    },
    orphanedAgreements: async () => {
      const sas = await all<{ id: string; customer_id: string }>((f, t) =>
        agr.from("service_agreements").select("id, customer_id").eq("status", "active").range(f, t))
      const open = new Set((await all<{ agreement_id: string }>((f, t) =>
        agr.from("ion_incarnations").select("agreement_id").is("to_at", null).range(f, t))).map((i) => i.agreement_id))
      return sas.filter((s) => !open.has(s.id)).map((s) => ({ agreementId: s.id, customerId: s.customer_id, ionCustId: null }))
    },
    agreementsOfCustomer: async (ionCustId) => {
      // ION customer -> our customer, then its agreements + open slice counts
      const pub = createClient(URL_, KEY)
      const { data: cust } = await pub.from("Customers").select("qbo_customer_id").eq("ion_cust_id", ionCustId).maybeSingle()
      if (!cust?.qbo_customer_id) return []
      const { data: sas } = await agr.from("service_agreements")
        .select("id, status").eq("customer_id", String(cust.qbo_customer_id))
      const out: { agreementId: string; openSlices: number; status: string }[] = []
      for (const sa of sas ?? []) {
        const { count } = await agr.from("ion_incarnations")
          .select("ion_task_id", { count: "exact", head: true }).eq("agreement_id", sa.id).is("to_at", null)
        out.push({ agreementId: sa.id, openSlices: count ?? 0, status: sa.status })
      }
      return out
    },
  }

  const report = await sweepIonTasks(deps, new Date().toISOString(), { apply })
  console.log(`\n=== SWEEP ${apply ? "APPLIED" : "(dry)"} ===`)
  console.log(`ION reports ${report.reportedTasks} active · the book holds ${report.bookSlices} open slices`)
  console.log(report.tally)
  for (const kind of ["ion_unknown", "book_only", "orphaned"] as const) {
    const of = report.divergences.filter((d) => d.kind === kind)
    if (!of.length) continue
    console.log(`\n${kind} (${of.length}):`)
    for (const d of of.slice(0, 25)) console.log(`  ${d.ionTaskId ?? d.agreementId}: ${d.remedy}${d.applied ? ` [${d.applied}]` : ""}${d.error ? ` — ${d.error}` : ""}`)
    if (of.length > 25) console.log(`  … and ${of.length - 25} more (nothing truncated in the run itself)`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
