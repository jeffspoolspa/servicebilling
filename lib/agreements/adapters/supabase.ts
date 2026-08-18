/**
 * Supabase + Windmill adapters for the agreements/routing sentences —
 * shared by the script harnesses, API routes, and Inngest functions
 * (ONE codebase; adapters live outside the sentences, RULED).
 */

import { createClient } from "@supabase/supabase-js"
import { ServiceAgreement } from "../domain/service-agreement/service-agreement"
import type { AgreementRepository } from "../domain/ports/agreement-repository"
import type { IntakeStore } from "../domain/ports/intake-store"
import type { TaskFormSource } from "../domain/ports/task-form-source"
import type { QuotaStore, PlacementStop } from "../../routing/domain/ports/quota-store"
import type { Basis } from "../domain/service-agreement/basis"
import type { TermsVersion } from "../domain/service-agreement/terms-version"
import type { IonIncarnation } from "../domain/service-agreement/ion-incarnation"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const agr = createClient(URL_, KEY, { db: { schema: "agreements" } })
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })
const maint = createClient(URL_, KEY, { db: { schema: "maintenance" } })

// Resolved lazily — WINDMILL_* env vars are Production-scoped, and reading
// them at module scope kills any build (Preview) that imports this file's
// dependents while collecting page data.
const wmApi = () =>
  `${process.env.WINDMILL_BASE_URL!.replace(/\/$/, "")}/w/${process.env.WINDMILL_WORKSPACE}`
const wmAuth = () => ({ Authorization: `Bearer ${process.env.WINDMILL_TOKEN}` })


export function repoAdapter(): AgreementRepository {
  async function hydrate(row: { id: string; customer_id: string; basis: Basis; status: "active" | "ended"; ended_on: string | null }) {
    const { data: tvs } = await agr.from("terms_versions")
      .select("version, pattern, billing, period, from_at, cause")
      .eq("agreement_id", row.id).order("version")
    const { data: incs } = await agr.from("ion_incarnations")
      .select("id, ion_task_id, from_at, to_at, cause, covers, intent, declared_at, landed_at, abandoned_at, abandoned_reason")
      .eq("agreement_id", row.id).order("from_at")
    const versions: TermsVersion[] = (tvs ?? []).map((v) => ({
      version: v.version, pattern: v.pattern, billing: v.billing,
      period: v.period, from: v.from_at, cause: v.cause,
    }))
    const incarnations: IonIncarnation[] = (incs ?? []).map((i) => ({
      id: i.id, ionTaskId: i.ion_task_id, from: i.from_at, to: i.to_at, cause: i.cause, covers: i.covers,
      intent: i.intent, declaredAt: i.declared_at, landedAt: i.landed_at,
      abandonedAt: i.abandoned_at, abandonedReason: i.abandoned_reason,
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
      // OUR id is the identity (write-ahead, RULED 2026-08-09): a
      // declaration inserts a row with no ion_task_id; landing binds it.
      const { data: dbIncs } = await agr.from("ion_incarnations")
        .select("id, ion_task_id, to_at, landed_at, abandoned_at").eq("agreement_id", a.id)
      const dbById = new Map((dbIncs ?? []).map((i) => [i.id, i]))
      for (const i of a.lineage()) {
        const db = dbById.get(i.id)
        if (!db) {
          const { error } = await agr.from("ion_incarnations").insert({
            id: i.id, agreement_id: a.id, ion_task_id: i.ionTaskId, from_at: i.from, to_at: i.to,
            cause: i.cause, covers: i.covers as object,
            intent: (i.intent as object) ?? null, declared_at: i.declaredAt ?? null,
            landed_at: i.landedAt ?? null, abandoned_at: i.abandonedAt ?? null,
            abandoned_reason: i.abandonedReason ?? null,
          })
          if (error) throw error
          continue
        }
        const patch: Record<string, unknown> = {}
        if (db.ion_task_id === null && i.ionTaskId !== null) {
          patch.ion_task_id = i.ionTaskId
          patch.landed_at = i.landedAt ?? new Date().toISOString()
        }
        if (db.to_at === null && i.to !== null) patch.to_at = i.to
        if (!db.abandoned_at && i.abandonedAt) {
          patch.abandoned_at = i.abandonedAt
          patch.abandoned_reason = i.abandonedReason ?? null
        }
        if (Object.keys(patch).length) {
          const { error } = await agr.from("ion_incarnations").update(patch).eq("id", i.id)
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
    const r = await fetch(`${wmApi()}/jobs/run/p/f/ION/api/get_task_forms_batch`, {
      method: "POST", headers: { ...wmAuth(), "Content-Type": "application/json" },
      body: JSON.stringify({ tasks }),
    })
    const jobId = (await r.text()).replace(/"/g, "")
    for (let i = 0; i < 120; i++) {
      await new Promise((res) => setTimeout(res, 5000))
      const jr = await fetch(`${wmApi()}/jobs_u/completed/get_result_maybe/${jobId}`, { headers: wmAuth() })
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


/** The fact sink: every sentence's facts land in the one stream. */
export const factsAdapter: import("../application/edit-agreement").FactSink = {
  async emit(rows) {
    if (!rows.length) return
    const { error } = await maint.from("events").insert(rows.map((r) => ({
      aggregate: r.aggregate, aggregate_id: r.aggregateId, type: r.type,
      actor: "system", occurred_at: r.at, participants: r.participants, payload: r.payload,
    })))
    if (error) throw error
  },
}
