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

/* ------------------------------- adapters -------------------------------- */

export function repoAdapter(): AgreementRepository {
  async function hydrate(row: { id: string; customer_id: string; basis: Basis; status: "active" | "ended"; ended_on: string | null }) {
    const { data: tvs } = await agr.from("terms_versions")
      .select("version, pattern, billing, period, from_at, cause")
      .eq("agreement_id", row.id).order("version")
    const { data: incs } = await agr.from("ion_incarnations")
      .select("ion_task_id, from_at, to_at, cause, covers")
      .eq("agreement_id", row.id).order("from_at")
    const versions: TermsVersion[] = (tvs ?? []).map((v) => ({
      version: v.version, pattern: v.pattern, billing: v.billing,
      period: v.period, from: v.from_at, cause: v.cause,
    }))
    const incarnations: IonIncarnation[] = (incs ?? []).map((i) => ({
      ionTaskId: i.ion_task_id, from: i.from_at, to: i.to_at, cause: i.cause, covers: i.covers,
    }))
    return ServiceAgreement.rehydrate(row.id, row.customer_id, row.basis, versions, incarnations, row.status, row.ended_on)
  }
  return {
    async byId(id) {
      const { data, error } = await agr.from("service_agreements")
        .select("id, customer_id, basis, status, ended_on").eq("id", id).maybeSingle()
      if (error) throw error
      return data ? hydrate(data) : null
    },
    async byIonTaskId(ionTaskId, onDate) {
      const { data, error } = await agr.from("ion_incarnations")
        .select("agreement_id, from_at, to_at").eq("ion_task_id", ionTaskId)
      if (error) throw error
      const hit = (data ?? []).find((i) => i.from_at.slice(0, 10) <= onDate && (i.to_at === null || i.to_at.slice(0, 10) >= onDate))
        ?? (data ?? []).find((i) => i.to_at === null)
        // an ENDED slice still names its agreement (the lifecycle read):
        ?? (data ?? []).sort((a, b) => a.from_at.localeCompare(b.from_at)).pop()
      return hit ? this.byId(hit.agreement_id) : null
    },
    async byCustomer(customerId) {
      const { data, error } = await agr.from("service_agreements")
        .select("id, customer_id, basis, status, ended_on").eq("customer_id", customerId)
      if (error) throw error
      return Promise.all((data ?? []).map(hydrate))
    },
    // save persists what the aggregate changed: new terms versions beyond
    // the stored max, incarnation closures/appends, lifecycle, and every
    // pulled fact. Level-triggered writes only — unchanged rows untouched.
    async save(a) {
      const { data: maxV } = await agr.from("terms_versions")
        .select("version").eq("agreement_id", a.id).order("version", { ascending: false }).limit(1).maybeSingle()
      for (const v of a.termsHistory()) {
        if (v.version <= (maxV?.version ?? 0)) continue
        const { error } = await agr.from("terms_versions").insert({
          agreement_id: a.id, version: v.version, pattern: v.pattern as object,
          billing: v.billing as object, period: v.period as object, from_at: v.from, cause: v.cause,
        })
        if (error) throw error
      }
      const { data: dbIncs } = await agr.from("ion_incarnations")
        .select("ion_task_id, from_at, to_at").eq("agreement_id", a.id)
      const dbByKey = new Map((dbIncs ?? []).map((i) => [`${i.ion_task_id}|${i.from_at}`, i]))
      for (const i of a.lineage()) {
        const db = dbByKey.get(`${i.ionTaskId}|${i.from}`)
        if (!db) {
          const { error } = await agr.from("ion_incarnations").insert({
            agreement_id: a.id, ion_task_id: i.ionTaskId, from_at: i.from, to_at: i.to,
            cause: i.cause, covers: i.covers as object,
          })
          if (error) throw error
        } else if (db.to_at === null && i.to !== null) {
          const { error } = await agr.from("ion_incarnations").update({ to_at: i.to })
            .eq("agreement_id", a.id).eq("ion_task_id", i.ionTaskId).eq("from_at", i.from)
          if (error) throw error
        }
      }
      const { error: eS } = await agr.from("service_agreements")
        .update({ status: a.status, ended_on: a.endedOn, updated_at: new Date().toISOString() }).eq("id", a.id)
      if (eS) throw eS
      const facts = a.pullEvents()
      if (facts.length) {
        const { error } = await maint.from("events").insert(facts.map((f) => ({
          aggregate: "agreement", aggregate_id: a.id, type: f.type, actor: "system",
          occurred_at: f.at, participants: f.participants, payload: f.payload,
        })))
        if (error) throw error
      }
    },
  }
}

export const intakeAdapter: IntakeStore = {
  async latest(ionTaskId) {
    const { data, error } = await agr.from("intake_translations")
      .select("observed_at, translation").eq("ion_task_id", ionTaskId)
      .order("observed_at", { ascending: false }).limit(1).maybeSingle()
    if (error) throw error
    return data ? { observedAt: data.observed_at, translation: data.translation } : null
  },
  async recordTranslation(ionTaskId, observedAt, translation, rawDelta) {
    const { error } = await agr.from("intake_translations").upsert(
      { ion_task_id: ionTaskId, observed_at: observedAt, translation: translation as object, raw_delta: rawDelta },
      { onConflict: "ion_task_id,observed_at" },
    )
    if (error) throw error
  },
  async recordFailure(ionTaskId, observedAt, failed, raw) {
    const { error } = await agr.from("intake_failures").insert({ ion_task_id: ionTaskId, observed_at: observedAt, failed, raw: raw as object })
    if (error) throw error
  },
  async replayableFailures() { return [] },
}

export const formsAdapter: TaskFormSource = {
  async fetchForms(tasks) {
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
  },
}

export const quotasAdapter: QuotaStore = {
  async quotaFor(agreementId, termsVersion) {
    const { data, error } = await rt.from("quotas").select("id")
      .eq("agreement_id", agreementId).eq("terms_version", termsVersion).maybeSingle()
    if (error) throw error
    return data
  },
  async mintQuota(agreementId, termsVersion) {
    const { data, error } = await rt.from("quotas")
      .insert({ agreement_id: agreementId, terms_version: termsVersion }).select("id").single()
    if (error) throw error
    return data
  },
  async headPlacement(quotaId) {
    const { data, error } = await rt.from("placement_versions").select("version, stops")
      .eq("quota_id", quotaId).order("version", { ascending: false }).limit(1).maybeSingle()
    if (error) throw error
    return data as { version: number; stops: PlacementStop[] } | null
  },
  async appendPlacement(quotaId, version, stops, fromDate, cause) {
    const { error } = await rt.from("placement_versions")
      .insert({ quota_id: quotaId, version, stops: stops as object, from_date: fromDate, cause })
    if (error) throw error
  },
}

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
