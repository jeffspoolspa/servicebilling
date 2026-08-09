/**
 * Seed quotas for agreements that have none — the convergence gap-filler
 * after a backfill mints new agreements (level-triggered; reruns no-op).
 *   npx tsx scripts/routing/seed-missing-quotas.ts
 */
import { createClient } from "@supabase/supabase-js"
import { convergePlacement, PlacementRuleError } from "../../lib/routing/application/converge-placement"
import { quotasAdapter, intakeAdapter } from "../agreements/refresh"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const agr = createClient(URL_, KEY, { db: { schema: "agreements" } })
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })

async function main() {
  const { data: agreements, error } = await agr.from("service_agreements")
    .select("id, status").eq("status", "active")
  if (error) throw error
  const { data: quotas } = await rt.from("quotas").select("agreement_id")
  const has = new Set((quotas ?? []).map((q) => q.agreement_id))
  const missing = (agreements ?? []).filter((a) => !has.has(a.id))
  console.log(`agreements without quotas: ${missing.length}`)

  const stats = { opened: 0, refused: 0, no_translation: 0 }
  const today = new Date().toISOString().slice(0, 10)
  for (const a of missing) {
    const { data: tv } = await agr.from("terms_versions")
      .select("version, pattern, from_at").eq("agreement_id", a.id)
      .order("version", { ascending: false }).limit(1).single()
    if (!tv) continue
    // NO FUTURE ERAS (RULED 2026-08-09): terms take effect when decided, so
    // there is no such thing as a not-yet-started version to skip.
    const { data: incs } = await agr.from("ion_incarnations")
      .select("ion_task_id, covers").eq("agreement_id", a.id).is("to_at", null)
    const stops: { weekday: number; techId: string; type: "clean" | "chem_check" }[] = []
    for (const inc of incs ?? []) {
      const last = await intakeAdapter.latest(inc.ion_task_id)
      const t = last?.translation as { schedule?: { stops: { weekday: number; techId: string }[] } } | null
      if (!t?.schedule) { stats.no_translation++; continue }
      const type = (inc.covers as { stopType: "clean" | "chem_check" }).stopType
      stops.push(...t.schedule.stops.map((s) => ({ ...s, type })))
    }
    if (!stops.length) continue
    try {
      await convergePlacement(quotasAdapter, {
        agreementId: a.id, termsVersion: tv.version,
        pattern: tv.pattern as never, stops, fromDate: today, cause: "opened",
      })
      stats.opened++
    } catch (e) {
      if (e instanceof PlacementRuleError) { stats.refused++; console.log(`  refused ${a.id}: ${e.message}`) }
      else throw e
    }
  }
  console.log(stats)
}

main().catch((e) => { console.error(e); process.exit(1) })
