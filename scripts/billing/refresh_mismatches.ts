/**
 * Reconcile-driven visit refresh — the remediation loop with the ledger guard.
 * `npx tsx scripts/billing/refresh_mismatches.ts <YYYY-MM-01>`
 *
 * reconcile -> refreshable mismatches (one attempt per task x report pull)
 * -> re-ingest their service days via f/ION/ingest_day_logs (chromium)
 * -> re-accrue affected customers -> re-reconcile -> stamp the ledger.
 */
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { BillingService } from "@/lib/application/billing/billing-service"
import { SupabaseBillingRepository, type BillingClient } from "@/lib/infrastructure/billing/supabase-billing-repository"

const MONTH = process.argv[2]
if (!MONTH || !/^\d{4}-\d{2}-01$/.test(MONTH)) {
  console.error("usage: npx tsx scripts/billing/refresh_mismatches.ts <YYYY-MM-01>")
  process.exit(1)
}

const mdy = (iso: string) => {
  const [y, m, d] = iso.split("-")
  return `${m}/${d}/${y}`
}

async function main() {
  const env: Record<string, string> = {}
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && !line.startsWith("#")) env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const service = new BillingService(new SupabaseBillingRepository(sb as unknown as BillingClient))

  const ingestDays = async (days: readonly string[]) => {
    if (!days.length) return
    const start = days[0], end = days[days.length - 1]
    console.log(`re-ingesting day grid ${start}..${end} (${days.length} service days in scope)...`)
    const r = await fetch(
      "https://app.windmill.dev/api/w/jps-internal/jobs/run/p/f/ION/ingest_day_logs?tag=chromium",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.WINDMILL_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: mdy(start), end_date: mdy(end), dry_run: false }),
      },
    )
    if (!r.ok) throw new Error(`ingest trigger failed: ${r.status} ${await r.text()}`)
    const jobId = (await r.text()).replaceAll('"', "")
    console.log(`  windmill job ${jobId} — polling...`)
    const t0 = Date.now()
    for (;;) {
      await new Promise((res) => setTimeout(res, 15000))
      const jr = await fetch(
        `https://app.windmill.dev/api/w/jps-internal/jobs_u/completed/get_result_maybe/${jobId}`,
        { headers: { Authorization: `Bearer ${env.WINDMILL_TOKEN}` } },
      )
      const j = (await jr.json()) as { completed: boolean; success?: boolean; result?: unknown }
      if (j.completed) {
        if (j.success === false) throw new Error(`ingest job failed: ${JSON.stringify(j.result).slice(0, 400)}`)
        console.log(`  ingest done in ${Math.round((Date.now() - t0) / 60000)} min`)
        return
      }
      if (Date.now() - t0 > 90 * 60000) throw new Error("ingest timed out after 90 min")
    }
  }

  const r = await service.refreshMismatches(MONTH, ingestDays)
  console.log(`\nbefore: ${r.before.exact} exact · ${r.before.mismatches.length} mismatches`)
  console.log(`attempted ${r.attempted} refresh(es) · ${r.skippedAlreadyTried} already tried against this report pull`)
  if (r.after) {
    console.log(`after:  ${r.after.exact} exact · ${r.after.chemPending.length} chem-pending · ${r.after.mismatches.length} mismatches`)
    for (const m of r.after.mismatches.slice(0, 20))
      console.log(`  still off: task ${m.ionTaskId}  diff ${(m.diffCents / 100).toFixed(2)}  ${m.customer ?? ""} — escalate to review`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
