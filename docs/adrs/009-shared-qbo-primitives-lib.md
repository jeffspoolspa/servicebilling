# ADR 009: Shared QBO primitives lib (one primitive = one side effect)

> Status: [accepted]
> Date: 2026-07-09
> Builds on [ADR 001](001-platform-architecture.md) and [ADR 008](008-inbox-single-writer-sync.md).
> ADR 008 said "one writer per entity" for the cache (data side). This is the
> same rule for the code side: one implementation per external operation.

## Context

The July 2026 audit found the money-critical QBO helpers are copy-pasted
across the Windmill scripts, not shared:

- `charge_card` / `charge_bank_account` — **4 copies** (maintenance +
  three service-billing scripts).
- `record_qbo_payment`, `get_qbo_invoice_details` / `lookup_invoice`,
  `send_receipt_then_invoice`, `_classify_charge_response` — **2 copies** each.
- `refresh_qbo_token` — **~35 copies**, in nearly every QBO-touching script.
  The OAuth refresh token rotates and burns if refreshed wrong — this is the
  most fragile code in the system, duplicated 35 ways.

The duplication was deliberate (`process_maint_period` comments say the
charge helpers were "cloned from f/service_billing/process_invoice"). It did
NOT protect the paths from each other — it let them **diverge in safety**:
the Phase 0 fresh-read guard went into maintenance's charge flow and the
service-billing twin did not get it for free; it had to be hand-copied into
`process_work_order`. Four copies means every hardening is a four-place chase
you will eventually miss.

## Decision

### 1. A shared Windmill lib for QBO primitives

Extract the primitives into a shared `_lib` module under `f/`, imported by
relative path — the established convention (`f/ION/_lib/session` already works
this way). The exact path follows Windmill's resolution; proposed:
`f/_lib/qbo/` (cross-cutting: billing + service_billing + check_buddy all
call `refresh_qbo_token`), split by resource:

    f/_lib/qbo/auth.py       refresh_qbo_token
    f/_lib/qbo/charges.py    charge_card, charge_bank_account,
                             _classify_charge_response, extract_charge_error
    f/_lib/qbo/invoices.py   get_qbo_invoice (the fresh read), send_invoice
    f/_lib/qbo/payments.py   record_qbo_payment, send_receipt, apply_credit

NOT the repo-root `lib/` — that is TypeScript for the Next.js app and is not
importable by Windmill Python (scripts run as isolated bundles on Windmill
Cloud, not in the Vercel process).

### 2. One primitive = one external side effect

A shared primitive maps to exactly ONE external call (one Intuit charge, one
QBO Payment create, one invoice GET, one `.../send`) and carries NO WAL /
state-machine / idempotency-sequencing logic. Consequences of the rule:

- **`send_receipt_then_invoice` decomposes** into two primitives —
  `send_receipt(payment_id, email)` and `send_invoice(invoice_id, email)` —
  each one call, each independently callable. "Receipt then invoice, skip if
  already sent" is a COMPOSITION the caller owns, because whether you want
  both / one / the other is context (autopay success = both; decline =
  invoice only; the call-center module = "resend invoice" and "resend
  receipt" as separate buttons). Boolean flags that switch off half a
  function (`send_invoice=False`, `payment_id=None`) are the smell that it
  was two functions.
- The test for the whole extraction: **atomic external call + no state logic
  → primitive in the lib; coordinates multiple calls with WAL / error
  handling / state transitions → stays orchestration in the engine.**

### 3. What stays per-engine

`process_one`, `process_customer_group`, `_run_group_charge`, the
`create_attempt`/`update_attempt` WAL sequencing, credit-application flow.
WO and maintenance orchestrate differently on purpose; forcing one shared
flow abstraction is the "interface with one implementation" trap. Share the
verbs, not the sentences. (The `billing.processing_attempts` WAL helpers are
a candidate for a *separate* shared billing-WAL lib later, but that is a
different concern from QBO primitives — do not fold it in here.)

### 4. Blast radius is the trade, and it is worth it

A shared charge function means a bug hits EVERY money path at once, where
today a bug is contained to one copy. That is still correct — you fix once
and cannot forget a copy — but it makes `f/_lib/qbo/` the highest-stakes code
in the repo. Therefore: it carries a standalone self-check (`__main__` /
demo asserting classification + error-extraction on canned responses), and
changes to it are reviewed as money changes, always deployed + dry-run
verified before a live run.

### 5. Sequencing (blast radius forbids a one-shot)

1. **Charge + fresh-read primitives first** (`charges.py`, `get_qbo_invoice`,
   `send_receipt`/`send_invoice`, `record_qbo_payment`) — 4-ish call sites.
   This collapses the maintenance fresh-read guard and its hand-copied WO
   twin into ONE shared, tested function (finishes Phase 0's WO pre-charge
   guard for free). Prove the shared-`_lib` import + deploy pattern end to
   end here.
2. **`refresh_qbo_token` second, as its own pass** — 35 sites, so it is the
   largest blast radius; do it deliberately, one caller batch at a time,
   after the pattern is proven.

## Consequences

- Phase 0 re-slots to build the charge/fresh-read primitives lib FIRST; the
  maintenance guard (shipped) and the WO twin (committed, undeployed) become
  callers of the shared helper instead of two hand-synced copies.
- Every future QBO hardening (SyncToken echo, token-bucket calls, retry
  policy) lands in one place and propagates to all money paths.
- `f/`/`u/` stay excluded from the app `tsconfig` (unchanged — Windmill
  runtime imports still don't resolve under `tsc`; see CLAUDE.md).
- New billing/QBO workflows compose primitives instead of cloning them; the
  clone-and-diverge failure mode is closed at the source.

## Addendum (2026-07-10): the `charge_and_record` service + three tiers + derived decline state

> Status: [accepted]
> Refines this ADR's §3 ("what stays per-engine") after a design review that
> walked the maintenance charge path end to end. §3 was too coarse: it kept
> *all* WAL sequencing per-engine. The finer, correct cut is below.

### A. Three tiers, split by concern (not by "shared vs not")

The boundary is **external side effect** vs **payment orchestration** vs
**billing policy** — each tier has a home:

| Tier | Examples | Home | Shared? |
|---|---|---|---|
| 1. Primitives (one side effect, no `conn`) | `charge_card`, `get_qbo_invoice_details`, `send_invoice`, `record_qbo_payment`; `mark_emailed`/`echo_balance` (one cache write); `create_attempt`/`update_attempt` (WAL) | `f/billing/_lib/qbo`, `_lib/cache`, `_lib/wal` | [shared] |
| 2. Payment service (idempotent charge core) | `charge_and_record` | `f/billing/_lib/payments` | [shared] |
| 3. Engine sentences (this workflow's policy) | `build_intent`, `deliver`, `record`, `outcome`, `process_one`, `_run_group_charge` | the engine file (`process_maint_period.py`, `process_work_order.py`) | [per-engine] |

Tier-3 functions live **in the engine file**, next to `process_one` — not in
`_lib` — because they encode policy that diverges (maintenance has an autopay
roster and group charges; a work order has neither). Share the verbs; keep the
sentences at home. A tier-3 helper is findable by scrolling up, so extraction
aids readability instead of scattering it.

### B. `charge_and_record` — the payment port

The refinement to §3: the **idempotent charge core** (WAL find-or-create +
fresh-read + charge + payment create) is NOT per-engine — it extracts into one
shared service. Only billing *policy* (decline handling, delivery, cache echo,
group anchoring) stays per-engine and dispatches on the service's result.

Contract:

    charge_and_record(conn, intent, access_token, realm_id, dry_run=False) -> Result

    intent  = { idempotency_scope, payment_method_id, channel,
                lines:[{invoice_id}], memo, customer_id,
                receipt_email: str | None }
    Result  = { status, amount, charge_id, payment_id, receipt_sent, error, balance }
      status in { read_failed, already_paid, would_charge, uncertain,
                  declined, payment_orphan, succeeded }  (one enum, used by the WAL too)

Invariants (all derived this session):

- **The service reads the balance fresh and decides the amount** — the caller
  passes invoice ids, never a number. This makes the Phase-0 "charge QBO's
  truth, not the cache" guard structural: there is no amount parameter to pass
  stale. A failed fresh read returns `read_failed` and HALTS (no cache
  fallback); `balance <= 0` returns `already_paid`.
- **WAL commits before the charge**, so a crash mid-charge is recoverable; a
  resume reuses the persisted idempotency key (Intuit dedupes). Resume is
  exempt from the fresh-read guard (balance may read 0 from our own in-flight
  charge).
- **The receipt is best-effort, after the money is durable, and non-fatal** —
  it runs last and its failure returns as `receipt_sent=False`, never a charge
  failure. The switch is **data** (`receipt_email` present or null), never a
  `send_receipt` boolean. A boolean that turns off half a function is the smell
  named in §2; a nullable destination keeps the service segment-blind (the
  caller nulls it for commercial customers who opt out).
- **The service is segment-blind.** The moment it learns *what kind* of
  customer it is charging, it has stopped being a payment port and become an
  engine. It charges and records; it does not know the invoice is a
  maintenance invoice and never touches an autopay roster.

### C. Verified-echo writes: one column per fact, when the fact is known

The cache echo is not one combined write. `email_status` is a fact we
**author** (the send returned ok) — write it immediately. `balance` is a value
we **observe** (only known after a confirming read) — write it at read time.
The auto-promote trigger (`balance <= 0 AND EmailSent`) is the **join**; it
re-evaluates on each write and is idempotent (DISTINCT-guarded), so
independent per-column writes are safe. What makes them safe is the Phase-0
discipline itself: the cache never holds a fabricated `<= 0` balance, so
`balance <= 0` always means really paid, so the trigger cannot fire on a lie
regardless of write order. Atomicity was a workaround for inaccurate
intermediate state; verified-echo removes the inaccuracy, so the workaround is
unnecessary.

### D. Decline state is a derived read-model, not engine-maintained

`billing.autopay_customers.consecutive_declines` / `payment_status` stop being
imperatively bumped/cleared by the engine. The `processing_attempts` table is
the fact log; autopay health is **derived on read** from it, keyed by
`payment_method_id`:

- `bump_declines` / `clear_declines` disappear from the hot path — recording
  the attempt IS the write.
- Derivation is idempotent (re-reads give the same count) and cannot drift
  from its source (the ADR 008 rollup-drift lesson applied to this column).
- Keying to `payment_method_id` makes "new card = clean slate" **structural** —
  a new pm has no failed attempts, so it reads healthy automatically. This
  removes the special-case reset in migration
  `20260511000002_attempts_ok_unblocks_on_pm_change`.
- **"Consecutive" is an ordered window**, not a `COUNT` — declines since the
  last `succeeded` for that pm. Put it in a view (`v_autopay_health`) so the
  threshold rule lives in one place.
- **Compute-on-read first** (a plain view); promote to a trigger-maintained
  column or materialized view ONLY on measured read pressure — mirroring the
  auto-promote trigger pattern. View first, materialize on evidence.
- Migration: current readers of `autopay_customers.payment_status` move to the
  view (or the column stays but becomes trigger-maintained from attempts). This
  is a [SCHEMA_OWNERSHIP](../conventions/SCHEMA_OWNERSHIP.md) change — the
  column flips from engine-written to derived.

### E. The through-line

`processing_attempts` is the source-of-truth event log. `processing_status`,
autopay health, and the invoice balance are **projections off facts** (ADR 008
§7 litmus: "compute over accumulated state" is the read/batch side; the
auto-promote trigger is the stream side). The engine's job shrinks to: do the
side effect, record what happened truthfully, and let derived state derive.

### F. Status

Target architecture. Phase-0 guard + verified-echo shipped (maintenance) /
committed-undeployed (WO). The extraction sequences per §5: primitives first,
then `charge_and_record` over them, then rewire both engines, then the derived
decline view. All money-code changes deploy + dry-run verify before a live run.

## See also

- [ADR 008](008-inbox-single-writer-sync.md) — the data-side twin (one writer
  per entity); this is one implementation per external operation.
- [conventions/SCRIPT_HEADER.md](../conventions/SCRIPT_HEADER.md),
  [conventions/CONCURRENCY_KEYS.md](../conventions/CONCURRENCY_KEYS.md)
- July 2026 sync audit — the duplication counts above.
