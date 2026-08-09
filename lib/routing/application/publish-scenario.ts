/**
 * PublishScenario — THE SENTENCE: realize an evaluated scenario against
 * ION. Re-derive every verdict AT PUBLISH TIME (the landing table is a
 * preview — write shapes and effective dates are properties of the
 * execution MOMENT, never of the stored plan), refuse the whole
 * publication if the fresh evaluation shows violations or never-valid
 * moves, then run every move through ChangeArrangement, record every
 * echo, and ledger every outcome — resumable because a completed move's
 * fresh diff is empty (planWrite answers "none") and skips itself.
 *
 *   fresh verdicts ─► REFUSE? (violations | never_valid | undecided
 *   non-default bridges in live mode) ─► per move: ChangeArrangement
 *   (dry|live) ─► ledger row (done | skipped_no_diff | failed |
 *   bridge_needs_probe) ─► summary
 *
 * Bridges: accepted proposals ledger as bridge_needs_probe until the
 * one-time ServiceRepeat id is read off a live blank form (the
 * boundary-week probe) — never guessed.
 */

import type { MoveVerdict } from "../domain/transition/transition-planner"
import type { ChangeReport } from "./change-arrangement"

export interface PublishMove {
  quotaId: string
  ionTaskId: string
  ionCustId: string
  targetStops: { weekday: number; techId: string; type: "clean" | "chem_check" }[]
  verdict: MoveVerdict
}

export interface PublicationStore {
  open(scenarioId: string, mode: "dry" | "live"): Promise<{ id: string }>
  refuse(publicationId: string, reason: string): Promise<void>
  recordMove(publicationId: string, row: {
    quotaId: string
    ionTaskId: string
    writeKind: string
    status: "done" | "skipped_no_diff" | "failed" | "bridge_needs_probe"
    ops: unknown[]
    echoes: unknown[]
    bridge?: unknown
    error?: string
  }): Promise<void>
  finish(publicationId: string, summary: Record<string, number>): Promise<void>
}

export interface PublishDeps {
  store: PublicationStore
  /** ChangeArrangement bound to its adapters (forms/repo/quotas/executor). */
  change: (input: {
    ionTaskId: string
    ionCustId: string
    targetStops: PublishMove["targetStops"]
    effectiveDate: string
    targetAnchorDate?: string
    dryRun: boolean
  }) => Promise<ChangeReport>
}

export interface PublishReport {
  publicationId: string
  refused: string | null
  summary: Record<string, number>
}

export async function publishScenario(
  deps: PublishDeps,
  scenarioId: string,
  moves: PublishMove[],
  mode: "dry" | "live",
): Promise<PublishReport> {
  const pub = await deps.store.open(scenarioId, mode)
  const summary: Record<string, number> = { done: 0, skipped_no_diff: 0, failed: 0, bridge_needs_probe: 0 }

  // publish-time refusal: the fresh evaluation must be CLEAN
  const neverValid = moves.filter((m) => m.verdict.validity === "never_valid")
  const violating = moves.filter((m) => m.verdict.violations.length > 0)
  const undecidedBridges = mode === "live"
    ? moves.filter((m) => m.verdict.bridges.some((b) => !b.defaultAccept))
    : []
  if (neverValid.length || violating.length || undecidedBridges.length) {
    const reason = [
      neverValid.length ? `${neverValid.length} never_valid` : null,
      violating.length ? `${violating.length} with cadence violations` : null,
      undecidedBridges.length ? `${undecidedBridges.length} with undecided bridge proposals` : null,
    ].filter(Boolean).join("; ")
    await deps.store.refuse(pub.id, reason)
    return { publicationId: pub.id, refused: reason, summary }
  }

  for (const m of moves) {
    try {
      const report = await deps.change({
        ionTaskId: m.ionTaskId,
        ionCustId: m.ionCustId,
        targetStops: m.targetStops,
        effectiveDate: m.verdict.effectiveDate!,
        ...(m.verdict.anchorDate && m.verdict.bridges.length === 0 && isIntervalRephase(m)
          ? { targetAnchorDate: m.verdict.anchorDate } : {}),
        dryRun: mode === "dry",
      })
      const status = report.ops.length === 0 ? "skipped_no_diff" : "done"
      await deps.store.recordMove(pub.id, {
        quotaId: m.quotaId, ionTaskId: m.ionTaskId, writeKind: report.plan,
        status, ops: report.ops, echoes: report.echoes,
      })
      summary[status]++

      // accepted bridge: a one-time no-charge rider — blocked on the probe
      const accepted = m.verdict.bridges.filter((b) => b.defaultAccept)
      if (accepted.length) {
        await deps.store.recordMove(pub.id, {
          quotaId: `${m.quotaId}`, ionTaskId: `${m.ionTaskId}:bridge`,
          writeKind: "create_one_time_qc",
          status: "bridge_needs_probe",
          ops: [], echoes: [], bridge: accepted,
        })
        summary.bridge_needs_probe++
      }
    } catch (e) {
      await deps.store.recordMove(pub.id, {
        quotaId: m.quotaId, ionTaskId: m.ionTaskId, writeKind: "unknown",
        status: "failed", ops: [], echoes: [], error: String(e).slice(0, 400),
      })
      summary.failed++
    }
  }

  await deps.store.finish(pub.id, summary)
  return { publicationId: pub.id, refused: null, summary }
}

/** anchor dates steer the write only for interval-cadence parity/phase
 *  changes; weekly moves carry their timing in effectiveDate alone. */
const isIntervalRephase = (m: PublishMove): boolean =>
  m.verdict.anchorDate !== null
