/**
 * FreshnessSource over the cache refresher.
 *
 * TaskCacheRefresher already does the work — read ION, reconcile our slots,
 * stamp ion_verified_at. This states its answer in the shape the domain port
 * asks for: which tasks are now known-true, and which are not and why.
 *
 * A task counts as verified when it was NOT skipped. That includes ones the
 * refresher found already fresh: the port's question is "is our copy true?",
 * not "did we re-read it just now" — and re-reading a task verified seconds
 * ago costs an ION round trip to learn what we already knew.
 *
 * Why a supersede refuses without this: the successor's anchor is derived
 * from the CURRENT contract, so a stale row yields a confidently wrong date.
 * Bayens, 2026-08-05 — our cache held starts_on 2025-01-03 with no live
 * cadence while ION held 2024-12-30 Bi-Weekly.
 */
import type { FreshnessSource } from "@/lib/maintenance/domain"
import type { TaskCacheRefresher } from "./task-cache-refresher"

export class RefresherFreshness implements FreshnessSource {
  constructor(
    private readonly refresher: TaskCacheRefresher,
    /**
     * How stale is too stale before a contract-changing write. Deliberately
     * tighter than the 60 minutes a read path is happy with: this number is
     * the window in which ION could have moved under us while we compute an
     * anchor from what we hold.
     */
    private readonly maxAgeMinutes = 5,
  ) {}

  async refresh(taskIds: readonly string[]) {
    if (taskIds.length === 0) return { verified: [], skipped: [], drift: [] }
    const report = await this.refresher.refresh(taskIds, this.maxAgeMinutes)
    const failed = new Set(report.skipped.map((s) => s.taskId))
    return {
      verified: taskIds.filter((id) => !failed.has(id)),
      skipped: report.skipped,
      drift: report.drift,
    }
  }
}
