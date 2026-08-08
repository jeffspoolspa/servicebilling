/**
 * Seed the routing floor from the agreements intake — the strangler bootstrap:
 * quotas + placement v1 come straight from ION's own translated forms, never
 * from the legacy task_schedules mirror (whose ghosts stay its own problem).
 *
 *   agreements (open incarnation → current terms era)
 *     + latest intake translation per ion task
 *     ──► convergePlacement (single writer of routing.placement_versions)
 *
 * Level-triggered and idempotent: re-runs converge to "unchanged".
 *
 *   npx tsx scripts/routing/seed-quotas-from-translations.ts
 */

import { createClient } from "@supabase/supabase-js"
import { convergePlacement, PlacementRuleError } from "../../lib/routing/application/converge-placement"
import type { PlacementCause, PlacementStop, QuotaStore } from "../../lib/routing/domain/ports/quota-store"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const agr = createClient(URL_, KEY, { db: { schema: "agreements" } })
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })

function supabaseQuotaStore(): QuotaStore {
  return {
    async quotaFor(agreementId, termsVersion) {
      const { data, error } = await rt
        .from("quotas").select("id")
        .eq("agreement_id", agreementId).eq("terms_version", termsVersion).maybeSingle()
      if (error) throw error
      return data
    },
    async mintQuota(agreementId, termsVersion) {
      const { data, error } = await rt
        .from("quotas").insert({ agreement_id: agreementId, terms_version: termsVersion })
        .select("id").single()
      if (error) throw error
      return data
    },
    async headPlacement(quotaId) {
      const { data, error } = await rt
        .from("placement_versions").select("version, stops")
        .eq("quota_id", quotaId).order("version", { ascending: false }).limit(1).maybeSingle()
      if (error) throw error
      return data as { version: number; stops: PlacementStop[] } | null
    },
    async appendPlacement(quotaId, version, stops, fromDate, cause: PlacementCause) {
      const { error } = await rt.from("placement_versions").insert({
        quota_id: quotaId, version, stops: stops as object, from_date: fromDate, cause,
      })
      if (error) throw error
    },
  }
}

/** Page through a supabase select past the 1000-row cap. LOUD, never silent. */
async function all<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw error
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) return out
  }
}

async function main() {
  const store = supabaseQuotaStore()

  const incarnations = await all<{ agreement_id: string; ion_task_id: string }>((f, t) =>
    agr.from("ion_incarnations").select("agreement_id, ion_task_id").is("to_at", null).range(f, t),
  )
  const terms = await all<{ agreement_id: string; version: number; pattern: object; from_at: string }>((f, t) =>
    agr.from("terms_versions").select("agreement_id, version, pattern, from_at").range(f, t),
  )
  const currentTerms = new Map<string, { version: number; pattern: object; from_at: string }>()
  for (const tv of terms) {
    const cur = currentTerms.get(tv.agreement_id)
    if (!cur || tv.version > cur.version) currentTerms.set(tv.agreement_id, tv)
  }
  const translations = await all<{ ion_task_id: string; observed_at: string; translation: { schedule: { stops: PlacementStop[] } } }>(
    (f, t) => agr.from("intake_translations").select("ion_task_id, observed_at, translation").range(f, t),
  )
  const latestTranslation = new Map<string, (typeof translations)[number]>()
  for (const tr of translations) {
    const cur = latestTranslation.get(tr.ion_task_id)
    if (!cur || tr.observed_at > cur.observed_at) latestTranslation.set(tr.ion_task_id, tr)
  }

  const stats = { opened: 0, appended: 0, unchanged: 0, no_translation: 0, refused: 0 }
  const refusals: string[] = []
  for (const inc of incarnations) {
    const era = currentTerms.get(inc.agreement_id)
    const tr = latestTranslation.get(inc.ion_task_id)
    if (!era || !tr) { stats.no_translation++; continue }
    try {
      const outcome = await convergePlacement(store, {
        agreementId: inc.agreement_id,
        termsVersion: era.version,
        frequency: era.pattern as never,
        stops: tr.translation.schedule.stops,
        fromDate: tr.observed_at.slice(0, 10),
        cause: "opened",
      })
      stats[outcome.action]++
    } catch (e) {
      if (e instanceof PlacementRuleError) {
        stats.refused++
        refusals.push(`${inc.ion_task_id}: ${e.message}`)
      } else throw e
    }
  }

  console.log("=== SEED COMPLETE ===")
  console.log(stats)
  if (refusals.length) {
    console.log("\nrefusals (translation self-inconsistency — investigate, never force):")
    for (const r of refusals) console.log(`  ${r}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
