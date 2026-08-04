# Nightly Accrual Cadence — decision map

> Status: [proposed]
> Parent: [index.md](index.md)

The rules the cadence runs by. Each rule names the DDD concept doing the work.

## Pre-conditions

- A month is **active** when its period overlaps today or it is period-closed but not yet
  invoiced and not manually parked. The active set is what the nightly tick route
  processes (read from `billing.v_active_months`).
- The visit ingester has run for the day (the tick runs after it).

## Decision sequence

1. **Rebuild is idempotent and always safe.** Accrue re-folds the month from current
   visits; billable items re-claim at current terms unless locked to an invoice
   (`qbo_invoice_id` set => immutable). Nothing about the aggregate changes for this flow.

2. **Phase 1: while the period is OPEN, accrual is the only step owed.** The domain
   (`nextStep`) returns null after accrue until `monthIsOver` — ION's invoices for the
   month do not exist yet, so a mid-month reconcile would dispute against nothing and
   burn a delivery refresh per night. The nightly AUDIT still runs regardless of steps,
   so flags surface all month. Reconcile happens at period close against the
   transactions report exactly as the July run proved. Phase 2 (the checksum) is what
   moves reconcile earlier.

   **And reconcile only judges a cache refreshed since the last run** (the report's
   trust window, 60 min): if the ION invoice-build or report step breaks, a stale
   cache must not dispute fresh accruals — every new visit would "disagree" with old
   data. `pulled_at` lives on the report ROWS, so a month ION has no invoices for has
   none and the same rule covers "the referee has not spoken yet" — the first
   period-close tick before ION's invoices are built cannot mass-dispute an empty
   report. Untrusted cache -> the month rests un-reconciled (cannot gate or issue)
   until a fresh pull exists. A FRESH month-wide report that lacks one customer is a
   real disagreement and disputes normally.

3. **The checksum reconcile (phase 2).** ION's rebuilt draft invoice total per task is a
   cheap checksum. Diff our accrued total per task against it:
   - Agree -> reconciled, no ION traffic beyond the one checksum fetch.
   - Disagree -> **targeted re-scrape** of that task's logs (the terminating refresh
     remediation the reconcile design already defines), then re-accrue. Never a blanket
     re-scrape.
   - This is what earns the ingester window shrink: the wide window existed to catch late
     edits; the checksum catches them by construction.

4. **The gate re-judges nightly, and its verdict is only ever current.** The one finding
   kind that holds a month is an open `cpv_outlier` flagged visit (per-visit consumable
   total >= p95 of the peer group, or >= p95 of the customer's own visits given >= 20
   visits of history; bulk refills exempt). Flags surface the night the visit lands —
   the rule is per-visit, so it is stable mid-month. Marking a visit reviewed is the
   resolution; manual holds survive rebuilds as today.

   **A finding's identity is its SUBJECT (rule + `source_key` = task:date), and a
   review resolves an OBSERVATION, not the visit** (RULED 2026-08-04): the sync
   re-raises a new finding when the rule's observed value (cents, for cpv) is not one
   already reviewed — so a chem added after your review re-flags, a bounce back to a
   reviewed state stays silent, open findings refresh their observation in place, and
   resolved rows are never touched. Sameness-of-lineage is the key; sameness-of-substance
   is the rule's authored observation. One rule exists today; per-rule grain waits for a
   second rule.

5. **The period-open invariant.** The issue command is **prohibited
   while the month's period is open** — visits may still be uncompleted, so the visit set
   is not complete. This is a precondition of the issue command, NOT a gate criterion:
   the calendar states a fact (period completeness); the gate judges data. On the 1st the
   period closes and the prohibition lifts.

6. **Issue needs no issue-day policy.** On the first tick after period close, the drainer
   advances months exactly as every other night; months that are reconciled-clean with no
   unresolved flagged visits and no manual hold pass the gate and flow into Invoice — the
   existing invoice queue machine takes them through create -> charge -> send -> receipt.
   There is no special issue-day code path.

7. **The 2nd, and really the first visit.** The next month begins accruing the moment its
   first visit lands; "starts on the 2nd" is just when the first tick sees it.

## Failure handling

- Checksum fetch fails (ION down / session dead): the month keeps last night's reconcile
  state and is retried next tick; no hold is created for infrastructure failures.
- Remediation does not converge (re-scrape still disagrees): the month stays unreconciled
  and therefore cannot issue; it surfaces on the exception list. Remediation terminates —
  it never loops within a tick.
- A visit lands after issue: it belongs to the next period by date; the issued month's
  items are locked. (Same-period late visits cannot happen — the period was closed.)

## Post-conditions

- Every active month's accrual, reconcile state, gate verdict, and flags are at most one
  day old, all month long.
- On the morning of the 1st the worklist IS the exception list: months held by open flags,
  unconverged reconciles, or manual holds. Everything else has issued.

## Rollout guardrails (temporary rules)

- First cycle supervised: auto-issue creates invoices but pauses before charge/send for a
  one-batch eyeball, then the pause is removed.
- The ingester window shrinks to 1 day only after a month or two of nightly checksum
  reconcile proving it catches what the wide window used to.
