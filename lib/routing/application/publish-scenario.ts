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
import type { ChangeReport, StepRecord } from "./change-arrangement"

export interface PublishMove {
  quotaId: string
  ionTaskId: string
  ionCustId: string
  targetStops: { weekday: number; techId: string; type: "clean" | "chem_check" }[]
  targetEndsOn?: string | null
  verdict: MoveVerdict
}

export interface PublicationStore {
  open(scenarioId: string, mode: "dry" | "live"): Promise<{ id: string }>
  refuse(publicationId: string, reason: string): Promise<void>
  /** A move opens as a RUNNING row before any verb fires, so the operator
   *  watches each step cross off live (RULED 2026-08-09). */
  openMove(publicationId: string, quotaId: string, ionTaskId: string, writeKind: string): Promise<void>
  /** Progressive step notes onto the running row (fire-and-forget). */
  noteSteps(publicationId: string, quotaId: string, ionTaskId: string, steps: StepRecord[]): Promise<void>
  recordMove(publicationId: string, row: {
    quotaId: string
    ionTaskId: string
    writeKind: string
    status: "done" | "skipped_no_diff" | "failed" | "bridge_needs_probe" | "landed_unverified" | "produced_no_change"
    ops: unknown[]
    echoes: unknown[]
    steps?: StepRecord[]
    bridge?: unknown
    error?: string
  }): Promise<void>
  finish(publicationId: string, summary: Record<string, number>): Promise<void>
  /** did an earlier publication of THIS scenario already land this task?
   *  (tells a resume apart from a change we failed to express) */
  alreadyLanded?(scenarioId: string, ionTaskId: string): Promise<boolean>
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
    targetEndsOn?: string | null
    dryRun: boolean
    onStep?: (steps: StepRecord[]) => void | Promise<void>
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
  const summary: Record<string, number> = {
    done: 0, skipped_no_diff: 0, failed: 0, bridge_needs_probe: 0,
    landed_unverified: 0, produced_no_change: 0,
  }

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
      await deps.store.openMove(pub.id, m.quotaId, m.ionTaskId, "pending")
      const report = await deps.change({
        ionTaskId: m.ionTaskId,
        ionCustId: m.ionCustId,
        targetStops: m.targetStops,
        targetEndsOn: m.targetEndsOn,
        effectiveDate: m.verdict.effectiveDate!,
        ...(m.verdict.anchorDate && m.verdict.bridges.length === 0 && isIntervalRephase(m)
          ? { targetAnchorDate: m.verdict.anchorDate } : {}),
        dryRun: mode === "dry",
        onStep: (steps) => deps.store.noteSteps(pub.id, m.quotaId, m.ionTaskId, steps),
      })
      // LIVE truthfulness, tightened (RULED 2026-08-09): "done" means the
      // converged placements row MATCHES the target (verify_floor passed).
      // Writes confirmed in ION while the floor does not yet say so are
      // landed_unverified — loud, never silently done, and never a lying
      // red failure on a landed write.
      // NO OPS IS NOT SUCCESS (RULED 2026-08-09): on a RESUME, an empty
      // diff means the move already landed — correct and silent. On a
      // first pass it means we could not express the operator's intent
      // (Marie Malone's parity flip rendered nothing and reported
      // "published"). The ledger tells them apart: a move already
      // recorded done in an earlier publication of this scenario is a
      // resume; anything else is a change we LOST.
      const allCommitted = report.echoes.every((e) => e.committed)
      const status = report.ops.length === 0
        ? ((await deps.store.alreadyLanded?.(scenarioId, m.ionTaskId)) ? "skipped_no_diff" : "produced_no_change")
        : mode === "live" && !allCommitted ? "failed"
        : mode === "live" && !report.verified ? "landed_unverified"
        : "done"
      const note = report.placementDeferred ?? report.recordSkipped
      await deps.store.recordMove(pub.id, {
        quotaId: m.quotaId, ionTaskId: m.ionTaskId, writeKind: report.plan,
        status, ops: report.ops, echoes: report.echoes, steps: report.steps,
        ...(status === "produced_no_change"
          ? { error: "the requested change rendered NO ION operations — its intent did not survive translation (see steps: plan)" }
          : status === "failed"
          ? { error: `halted at ${report.steps.find((st) => st.status === "failed")?.step ?? "an unverified op"} (see steps)` }
          : status === "landed_unverified"
            ? { error: `note: ION writes confirmed; floor not verified — ${note ?? report.steps.find((st) => st.status === "failed")?.step ?? "see steps"}` }
            : note ? { error: `note: ${note}` } : {}),
      })
      if (note) summary.deferred_bookkeeping = (summary.deferred_bookkeeping ?? 0) + 1
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
        status: "failed", ops: [], echoes: [],
        error: (e instanceof Error ? e.message : JSON.stringify(e)).slice(0, 400),
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
