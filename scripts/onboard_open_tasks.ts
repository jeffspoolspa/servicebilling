/**
 * Open the onboarded customers' recurring tasks in ION via TaskOpeningService.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/onboard_open_tasks.ts <plan.json> [--test | --live]
 *
 * Default: DRY over the whole plan — validates the linked set, computes every
 * start date, and checks each customer's blank create form primes correctly.
 * --test: ONE live create on the TEST 2.0 customer (weekly Friday), the
 * canary for the real batch. --live: create all tasks in the plan.
 */

import "./_env"
import { readFileSync } from "node:fs"
import { TaskOpeningService, type TaskToOpen } from "@/lib/application/customers/task-opening-service"
import { SupabaseCustomerRepository } from "@/lib/infrastructure/customers/supabase-customer-repository"
import { IonTaskAcl } from "@/lib/infrastructure/ion/acl"
import { IonTasks } from "@/lib/infrastructure/ion/ion"
import { triggerScriptSync } from "@/lib/windmill"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

/** House defaults, copied once from a real maintenance task (HARRIS, 6026080). */
const TEMPLATE: Record<string, string> = {
  sendlog: "1",
  SendConsumables: "1",
  sendtechnote: "1",
  SendFiles: "1",
  imgRequired: "1",
  InvoiceType: "4",
  InvoiceDate: "99",
}

interface PlanRow {
  num: string
  displayName: string
  accountId: number | null
  profile: { frequency: string; weekday: number; ratePerVisit: number | null } | null
  notes: string[]
}

async function main() {
  const [planPath] = process.argv.slice(2)
  const test = process.argv.includes("--test")
  const live = process.argv.includes("--live")
  if (!planPath) throw new Error("usage: onboard_open_tasks.ts <plan.json> [--test | --live]")

  const plan = JSON.parse(readFileSync(planPath, "utf8")) as { tech: { ionEmployeeId: string }; rows: PlanRow[] }
  const service = new TaskOpeningService(
    new SupabaseCustomerRepository(createSupabaseAdmin() as unknown as ConstructorParameters<typeof SupabaseCustomerRepository>[0]),
    new IonTasks({ mint: (force) => triggerScriptSync("f/ION/api/get_session", { force_refresh: force }, { timeoutMs: 180000 }) }),
    new IonTaskAcl(),
  )
  const notBefore = new Date().toISOString().slice(0, 10)

  let tasks: TaskToOpen[]
  if (test) {
    // The canary: TEST 2.0 (ion_cust 2545431) — find its account row.
    const sb = createSupabaseAdmin()
    const { data, error } = await sb.from("Customers").select("id").eq("ion_cust_id", "2545431").limit(1)
    if (error || !data?.length) throw new Error(`TEST 2.0 (ion_cust 2545431) has no Customers row: ${JSON.stringify(error ?? "none")}`)
    tasks = [{ accountId: (data[0] as { id: number }).id, displayName: "TEST 2.0", frequency: "weekly", weekday: 5, ratePerVisit: 1, poolType: "Salt Test Pool", note: "canary — safe to delete" }]
  } else {
    tasks = plan.rows
      .filter((r): r is PlanRow & { accountId: number; profile: NonNullable<PlanRow["profile"]> } => r.accountId !== null && r.profile !== null)
      .map((r) => ({
        accountId: r.accountId,
        displayName: r.displayName,
        frequency: r.profile.frequency as TaskToOpen["frequency"],
        weekday: r.profile.weekday,
        ratePerVisit: r.profile.ratePerVisit,
        poolType: (r.notes.find((n) => n.startsWith("pool: ")) ?? "pool: ").slice(6),
        note: r.notes.filter((n) => /gate|pool|billing|segment/.test(n)).join(" | "),
      }))
  }

  const t0 = Date.now()
  const results = await service.open(tasks, { ionTech: plan.tech.ionEmployeeId, template: TEMPLATE, notBefore, dryRun: !(test || live) })
  const ok = results.filter((r) => r.accepted)
  console.log(`--- ${Math.round((Date.now() - t0) / 1000)}s (${test ? "TEST" : live ? "LIVE" : "DRY"}) ---`)
  console.log(`accepted ${ok.length} / ${results.length}`)
  for (const r of results) console.log(`  ${r.accepted ? "ok " : "NO "} ${r.displayName.padEnd(24)} ${r.ionTaskId ? `task=${r.ionTaskId} ` : ""}${r.detail}`)
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e)
  process.exit(1)
})
