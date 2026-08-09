/**
 * The refresh harness: run RefreshAgreement over one agreement, one ION
 * task's agreement, or the whole active book. Adapters live HERE (the
 * sentence sees ports only): supabase repo/intake/quotas + the Windmill
 * batch form fetcher (one warm session).
 *
 *   npx tsx scripts/agreements/refresh.ts --ion-task 5764017
 *   npx tsx scripts/agreements/refresh.ts --agreement <uuid>
 *   npx tsx scripts/agreements/refresh.ts --all [--limit N]
 */

import { createClient } from "@supabase/supabase-js"
import { refreshAgreement, type RefreshDeps } from "../../lib/agreements/application/refresh-agreement"
import { ServiceAgreement } from "../../lib/agreements/domain/service-agreement/service-agreement"
import type { AgreementRepository } from "../../lib/agreements/domain/ports/agreement-repository"
import type { IntakeStore } from "../../lib/agreements/domain/ports/intake-store"
import type { TaskFormSource } from "../../lib/agreements/domain/ports/task-form-source"
import type { QuotaStore, PlacementStop } from "../../lib/routing/domain/ports/quota-store"
import type { Basis } from "../../lib/agreements/domain/service-agreement/basis"
import type { TermsVersion } from "../../lib/agreements/domain/service-agreement/terms-version"
import type { IonIncarnation } from "../../lib/agreements/domain/service-agreement/ion-incarnation"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const agr = createClient(URL_, KEY, { db: { schema: "agreements" } })
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })
const maint = createClient(URL_, KEY, { db: { schema: "maintenance" } })

const WM_API = `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const WM_AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` }

/* adapters graduated to lib/agreements/adapters/supabase.ts (shared with
   API routes + Inngest); re-exported here so script imports keep working */
export { repoAdapter, intakeAdapter, formsAdapter, quotasAdapter } from "../../lib/agreements/adapters/supabase"
import { repoAdapter, intakeAdapter, formsAdapter, quotasAdapter } from "../../lib/agreements/adapters/supabase"

/* -------------------------------- harness -------------------------------- */

const argOf = (flag: string) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : null
}

async function main() {
  const deps: RefreshDeps = {
    repo: repoAdapter(), intake: intakeAdapter, forms: formsAdapter,
    quotas: quotasAdapter, catalogPriceCents: () => null,
  }
  const at = new Date().toISOString()

  let ids: string[] = []
  if (argOf("--agreement")) ids = [argOf("--agreement")!]
  else if (argOf("--ion-task")) {
    const a = await deps.repo.byIonTaskId(argOf("--ion-task")!, at.slice(0, 10))
    if (!a) throw new Error(`no agreement holds ion task ${argOf("--ion-task")}`)
    ids = [a.id]
  } else if (process.argv.includes("--all")) {
    const out: string[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await agr.from("service_agreements").select("id").eq("status", "active").range(from, from + 999)
      if (error) throw error
      out.push(...(data ?? []).map((r) => r.id))
      if ((data ?? []).length < 1000) break
    }
    ids = out.slice(0, Number(argOf("--limit") ?? out.length))
  } else {
    throw new Error("usage: refresh.ts --agreement <id> | --ion-task <id> | --all [--limit N]")
  }

  const tally = { unchanged: 0, versioned: 0, ended: 0, placementMoved: 0, partial: 0, quarantined: 0, coversDrift: 0 }
  for (const id of ids) {
    const r = await refreshAgreement(deps, id, at)
    tally[r.terms === "unchanged" ? "unchanged" : r.terms === "versioned" ? "versioned" : "ended"]++
    if (r.placement === "appended" || r.placement === "opened") tally.placementMoved++
    if (r.partial) tally.partial++
    tally.quarantined += r.quarantined
    tally.coversDrift += r.coversDrift.length
    if (ids.length === 1 || r.terms !== "unchanged" || r.partial || r.placement === "appended" || r.mixedBilling.length) {
      console.log(`${id}: terms=${r.terms} placement=${r.placement} slices=${r.slices} quarantined=${r.quarantined}${r.partial ? " PARTIAL" : ""}${r.coversDrift.length ? ` DRIFT:${r.coversDrift.join(",")}` : ""}${r.mixedBilling.length ? ` MIXED-BILLING[${r.mixedBilling.join("; ")}]` : ""}`)
    }
  }
  console.log("\n=== REFRESH COMPLETE ===")
  console.log(tally)
}

if (process.argv[1]?.endsWith("refresh.ts")) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
