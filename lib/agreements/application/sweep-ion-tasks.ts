/**
 * SweepIonTasks — THE BACKSTOP for changes made OUTSIDE our application
 * (RULED 2026-08-09, Carter). It reads ION's active-task report, set-
 * differences it against the book, and TRANSLATES what it sees into the
 * vocabulary we already have — it owns no vocabulary of its own:
 *
 *     an observed difference  ->  agreement_terms_changed
 *                             ->  placement_converged
 *                             ->  agreement_ion_task_superseded
 *                             ->  agreement_ended
 *
 * and a difference that is the result of a change WE made converges to
 * exactly the facts we already recorded, which means it does NOTHING.
 * That is the shape: level-triggered convergence, silence on agreement.
 *
 * IT IS NOT THE MECHANISM FOR OUR OWN WRITES. Relying on an ION read to
 * learn what our own application did would mean we did something wrong
 * (Carter, 2026-08-09) — our writes declare their intent BEFORE touching
 * ION and land it on confirmation, so the book knows them without asking.
 * What is left for the sweep is genuinely external: a tech edited a task
 * in ION, someone deleted one, a task was created by hand.
 *
 *   "they would have showed up on the active task report as tasks that we
 *    don't have right on the sweep?"
 *
 * They would have. Nobody was looking: the report's mirror was two months
 * stale while 36 agreements quietly lost their slices. The per-agreement
 * refresh cannot see this class at all — it asks ION about tasks the book
 * already knows, so a successor the book never learned is invisible to
 * it, and an orphaned agreement looks like a cancellation.
 *
 * THE THREE DIVERGENCES (each names its own remedy):
 *
 *   ion_unknown   ION holds an active task no open incarnation carries.
 *                 A successor we failed to record, or a task made by hand
 *                 in ION. Remedy: ATTACH to the customer's agreement by
 *                 the evidence ladder, or MINT when the customer has
 *                 none. Ambiguity quarantines — never a guess.
 *
 *   book_only     the book holds a slice ION's report does not carry.
 *                 The task ended or was deleted. Remedy: close the slice.
 *                 Ending the AGREEMENT is a separate ruling that requires
 *                 the customer to have no live task at all — the
 *                 distinction a per-agreement read cannot make, and
 *                 getting it wrong is what ended 20 live agreements.
 *
 *   duplicate_claim  two agreements carry the SAME ION task. Found on
 *                 2026-08-09 via ELOPER task 6031438: one agreement
 *                 closed it correctly when ION expired it, a second still
 *                 held it open, so the floor kept drawing an expired
 *                 stop. A task belongs to ONE agreement; the claim with
 *                 the live lineage keeps it.
 *
 *   orphaned      an active agreement with no open slice. Resolved by the
 *                 two above: it either regains a slice (attach) or is
 *                 provably cancelled (no live task for that customer).
 *
 * Dry by default: a sweep REPORTS, and only applies when armed. A
 * divergence it cannot express in our vocabulary is QUARANTINED for a
 * human — never guessed, never given a private fact type.
 */

import type { AgreementRepository } from "../domain/ports/agreement-repository"
import type { IntakeStore } from "../domain/ports/intake-store"
import type { QuotaStore } from "../../routing/domain/ports/quota-store"
import type { IonIncarnation } from "../domain/service-agreement/ion-incarnation"
import { editAgreement, type FactSink } from "./edit-agreement"

/** One row of ION's active-task report — the least it must carry. */
export interface IonActiveTask {
  ionTaskId: string
  ionCustId: string
  /** ION's customer name, for the report only (never matched on). */
  customerName?: string
}

/** What the book holds, from the reader's own query. */
export interface BookSlice {
  ionTaskId: string
  agreementId: string
  customerId: string
  ionCustId: string | null
}

export interface SweepDeps {
  repo: AgreementRepository
  intake: IntakeStore
  quotas: QuotaStore
  /** every divergence is a fact — the sweep's findings must be traceable
   *  the same way a publish's verbs are (RULED 2026-08-09) */
  facts?: FactSink
  /** ION's active-task report (the whole population, one read). */
  activeTasks: () => Promise<IonActiveTask[]>
  /** every OPEN slice the book carries */
  bookSlices: () => Promise<BookSlice[]>
  /** active agreements holding NO open slice */
  orphanedAgreements: () => Promise<{ agreementId: string; customerId: string; ionCustId: string | null }[]>
  /** agreements for one ION customer, with their open slice count */
  agreementsOfCustomer: (ionCustId: string) => Promise<{ agreementId: string; openSlices: number; status: string }[]>
  /** declarations we made that never landed — OUR defects, surfaced
   *  separately from ION-side change (RULED 2026-08-09) */
  pendingDeclarations?: () => Promise<{
    declarationId: string; agreementId: string; ionTaskId: string | null
    ionCustId: string | null; intent: unknown
  }[]>
}

export interface Divergence {
  kind: "ion_unknown" | "book_only" | "orphaned" | "duplicate_claim" | "our_write_unconfirmed"
  ionTaskId: string | null
  ionCustId: string | null
  agreementId: string | null
  /** what the sweep would do, in words the operator can rule on */
  remedy: string
  /** applied only when armed */
  applied?: "attached" | "closed" | "quarantined" | "failed"
  error?: string
}

export interface SweepReport {
  reportedTasks: number
  bookSlices: number
  divergences: Divergence[]
  tally: Record<string, number>
}

export async function sweepIonTasks(
  deps: SweepDeps,
  at: string,
  opts: { apply: boolean } = { apply: false },
): Promise<SweepReport> {
  const [active, slices, orphans] = await Promise.all([
    deps.activeTasks(), deps.bookSlices(), deps.orphanedAgreements(),
  ])
  const report: SweepReport = {
    reportedTasks: active.length, bookSlices: slices.length, divergences: [], tally: {},
  }

  const bookByTask = new Map(slices.map((s) => [s.ionTaskId, s]))
  const activeById = new Map(active.map((t) => [t.ionTaskId, t]))

  /* --------- OUR OWN WORK, SEEN FROM ION: a bug, not a divergence -------- */
  // Every task we wrote was DECLARED before the write and LANDED on
  // confirmation, so the book knows it without asking ION. If the sweep
  // finds a task matching one of our pending declarations, exactly one of
  // two things is true and both are OUR defect (Carter, 2026-08-09):
  //   - the fact never reached ION  -> it failed downstream
  //   - ION has it and we never landed it -> we failed to record it
  // Either way it is not an ION-side change, and it is reported as a
  // defect against the declaration rather than laundered into an
  // ion_side observation.
  const pending = await deps.pendingDeclarations?.() ?? []
  for (const p of pending) {
    const inIon = active.find((t) => t.ionTaskId === p.ionTaskId) ??
      (p.ionTaskId ? undefined : undefined)
    report.divergences.push({
      kind: "our_write_unconfirmed", ionTaskId: p.ionTaskId ?? null, ionCustId: p.ionCustId ?? null,
      agreementId: p.agreementId,
      remedy: inIon
        ? `OUR DEFECT: ION holds this task and declaration ${p.declarationId} never landed — the book failed to record a change that went through our domain model`
        : `OUR DEFECT: declaration ${p.declarationId} was recorded and ION does not hold it — the write failed downstream. Intent: ${JSON.stringify(p.intent)}`,
      applied: "quarantined",
    })
  }

  /* ------------------------- ION holds, book does not -------------------- */
  for (const t of active) {
    if (bookByTask.has(t.ionTaskId)) continue
    const candidates = await deps.agreementsOfCustomer(t.ionCustId)
    const live = candidates.filter((c) => c.status === "active")
    // THE ATTACH-OR-MINT LADDER (RULED): no agreement -> mint; exactly one
    // -> attach; several -> the evidence must decide, and inconclusive
    // evidence QUARANTINES rather than guesses (guessing is what produced
    // the wrong-tech publish).
    const d: Divergence = {
      kind: "ion_unknown", ionTaskId: t.ionTaskId, ionCustId: t.ionCustId,
      agreementId: null, remedy: "",
    }
    if (live.length === 0) {
      d.remedy = `mint an agreement for ION customer ${t.ionCustId} (no active agreement holds it)`
    } else if (live.length === 1) {
      d.agreementId = live[0].agreementId
      d.remedy = live[0].openSlices === 0
        ? `attach to ${live[0].agreementId} — its only agreement, currently orphaned (this is the unrecorded successor)`
        : `attach to ${live[0].agreementId} — the customer's only active agreement`
    } else {
      const orphanedOnes = live.filter((c) => c.openSlices === 0)
      if (orphanedOnes.length === 1) {
        d.agreementId = orphanedOnes[0].agreementId
        d.remedy = `attach to ${orphanedOnes[0].agreementId} — the only one of ${live.length} agreements missing a slice`
      } else {
        d.remedy = `QUARANTINE: ${live.length} active agreements for this customer and the evidence is inconclusive — a human rules`
        d.applied = "quarantined"
      }
    }
    report.divergences.push(d)
  }

  /* ---------------------- two agreements, one ION task ------------------- */
  const claimsByTask = new Map<string, BookSlice[]>()
  for (const s2 of slices) claimsByTask.set(s2.ionTaskId, [...(claimsByTask.get(s2.ionTaskId) ?? []), s2])
  for (const [taskId, claims] of claimsByTask) {
    if (claims.length < 2) continue
    report.divergences.push({
      kind: "duplicate_claim", ionTaskId: taskId, ionCustId: claims[0].ionCustId,
      agreementId: claims.map((c) => c.agreementId).join(" | "),
      remedy: `${claims.length} agreements hold this ION task open — one must release it; a human rules which lineage is real`,
      applied: "quarantined",
    })
  }

  /* ------------------------- book holds, ION does not -------------------- */
  for (const s of slices) {
    if (activeById.has(s.ionTaskId)) continue
    report.divergences.push({
      kind: "book_only", ionTaskId: s.ionTaskId, ionCustId: s.ionCustId,
      agreementId: s.agreementId,
      remedy: `close the slice on ${s.agreementId} — ION's report no longer carries this task`,
    })
  }

  /* -------------------------------- orphans ------------------------------ */
  for (const o of orphans) {
    const willAttach = report.divergences.some(
      (d) => d.kind === "ion_unknown" && d.agreementId === o.agreementId,
    )
    report.divergences.push({
      kind: "orphaned", ionTaskId: null, ionCustId: o.ionCustId, agreementId: o.agreementId,
      remedy: willAttach
        ? "regains its slice from an unrecorded ION task (see the attach above)"
        : "no live ION task claims it — a human confirms cancellation before it ends",
    })
  }

  /* -------------------------------- apply -------------------------------- */
  if (opts.apply) {
    for (const d of report.divergences) {
      if (d.applied === "quarantined") continue
      try {
        if (d.kind === "ion_unknown" && d.agreementId) {
          // the successor lands on the SAME agreement, through the one
          // sentence — provenance ion_side, because we observed it
          await editAgreement({ repo: deps.repo, intake: deps.intake, quotas: deps.quotas }, {
            agreementId: d.agreementId, origin: "ion_side", at,
            incarnation: {
              ionTaskId: d.ionTaskId!, cause: "ion_side",
              covers: await coversFor(deps, d.agreementId, d.ionTaskId!),
            },
          })
          d.applied = "attached"
        } else if (d.kind === "book_only" && d.agreementId) {
          // closing a slice is a change like any other; the agreement does
          // NOT end here — orphan resolution is a separate ruling
          await editAgreement({ repo: deps.repo, intake: deps.intake, quotas: deps.quotas }, {
            agreementId: d.agreementId, origin: "ion_side", at,
            incarnation: {
              ionTaskId: d.ionTaskId!, cause: "ion_side",
              covers: await coversFor(deps, d.agreementId, d.ionTaskId!),
            },
          })
          d.applied = "closed"
        }
      } catch (e) {
        d.applied = "failed"
        d.error = (e instanceof Error ? e.message : String(e)).slice(0, 200)
      }
    }
  }

  for (const d of report.divergences) {
    report.tally[d.kind] = (report.tally[d.kind] ?? 0) + 1
    if (d.applied) report.tally[d.applied] = (report.tally[d.applied] ?? 0) + 1
  }
  if (report.divergences.length) {
    await deps.facts?.emit(report.divergences.map((d) => ({
      aggregate: "agreement", aggregateId: d.agreementId ?? "unattached",
      type: d.applied ? "ion_divergence_resolved" : "ion_divergence_detected", at,
      participants: [
        ...(d.agreementId ? [`agreement:${d.agreementId}`] : []),
        ...(d.ionTaskId ? [`ion_task:${d.ionTaskId}`] : []),
      ],
      payload: { kind: d.kind, remedy: d.remedy, applied: d.applied ?? null, error: d.error ?? null },
    })))
  }
  return report
}

/** A new slice covers what its agreement's other slices cover; a lone
 *  agreement's first slice defaults to clean. Never guessed silently —
 *  covers drift is caught by the refresh's own check. */
async function coversFor(
  deps: SweepDeps, agreementId: string, ionTaskId: string,
): Promise<IonIncarnation["covers"]> {
  const a = await deps.repo.byId(agreementId)
  const known = a?.lineage().find((i) => i.ionTaskId === ionTaskId) ?? a?.lineage().slice(-1)[0]
  if (!known) throw new Error(`cannot state what ${ionTaskId} covers: agreement ${agreementId} has no lineage`)
  return known.covers
}
