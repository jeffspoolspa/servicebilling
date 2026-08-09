/**
 * Inngest functions — thin hosts over the application sentences.
 *
 *   routing/scenario.publish  -> publish a scenario LIVE through the
 *                                sentence pipeline (concurrency 1: ION is
 *                                one session; the lease is belt-and-braces)
 *   nightly refresh           -> the regular ingester THROUGH THE DOMAIN:
 *                                refreshAgreement over the active book
 *                                (replaces the legacy mirror flows as the
 *                                freshness mechanism)
 *
 * Idempotency is the sentences' own: a re-delivered publish event finds
 * empty diffs and skips itself; a re-run refresh converges to unchanged.
 */
import { inngest } from "./inngest"
import { createClient } from "@supabase/supabase-js"
import { refreshAgreement, type RefreshDeps } from "../agreements/application/refresh-agreement"
import { repoAdapter, intakeAdapter, formsAdapter, quotasAdapter, factsAdapter } from "../agreements/adapters/supabase"

const deps = (): RefreshDeps => ({
  repo: repoAdapter(), intake: intakeAdapter, forms: formsAdapter,
  quotas: quotasAdapter, catalogPriceCents: () => null, facts: factsAdapter,
})

export const publishScenarioFn = inngest.createFunction(
  { id: "publish-scenario", concurrency: 1, retries: 2, triggers: { event: "routing/scenario.publish" } },
  async ({ event, step }: { event: { data: { scenarioId: string } }; step: { run<T>(name: string, fn: () => Promise<T>): Promise<T> } }) => {
    const scenarioId = event.data.scenarioId as string
    // the sentence pipeline runs as ONE step: it is internally resumable
    // (level-triggered per move), so a retry re-enters safely and skips
    // whatever already landed
    return await step.run("publish", async () => {
      const { runPublish } = await import("./publish-runner")
      return runPublish(scenarioId, { live: true })
    })
  },
)

export const refreshAgreementsNightly = inngest.createFunction(
  // 09:00 UTC = after ION's own day rolls over
  { id: "refresh-agreements-nightly", concurrency: 1, retries: 1, triggers: { cron: "0 9 * * *" } },
  async ({ step }: { step: { run<T>(name: string, fn: () => Promise<T>): Promise<T> } }) => {
    const agr = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: "agreements" } })
    const ids: string[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await agr.from("service_agreements")
        .select("id").eq("status", "active").range(from, from + 999)
      if (error) throw error
      ids.push(...(data ?? []).map((r) => r.id))
      if ((data ?? []).length < 1000) break
    }
    // batches as separate steps: each is retried independently and the
    // function survives redeploys mid-run
    const summary = { unchanged: 0, versioned: 0, ended: 0, orphaned: 0, moved: 0, partial: 0 }
    for (let i = 0; i < ids.length; i += 25) {
      const batch = ids.slice(i, i + 25)
      const results = await step.run(`refresh-${i / 25}`, async () => {
        const d = deps()
        const out: { terms: string; placement: string; partial: boolean }[] = []
        for (const id of batch) {
          const r = await refreshAgreement(d, id, new Date().toISOString())
          out.push({ terms: r.terms, placement: r.placement, partial: r.partial })
        }
        return out
      })
      for (const r of results) {
        if (r.partial) summary.partial++
        else if (r.terms === "orphaned") summary.orphaned++ // the sweep rules on these
        else if (r.terms === "ended") summary.ended++
        else if (r.terms === "versioned") summary.versioned++
        else summary.unchanged++
        if (r.placement === "appended" || r.placement === "opened") summary.moved++
      }
    }
    return summary
  },
)

export const functions = [publishScenarioFn, refreshAgreementsNightly]
