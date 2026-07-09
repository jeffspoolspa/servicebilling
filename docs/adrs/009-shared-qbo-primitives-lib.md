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

## See also

- [ADR 008](008-inbox-single-writer-sync.md) — the data-side twin (one writer
  per entity); this is one implementation per external operation.
- [conventions/SCRIPT_HEADER.md](../conventions/SCRIPT_HEADER.md),
  [conventions/CONCURRENCY_KEYS.md](../conventions/CONCURRENCY_KEYS.md)
- July 2026 sync audit — the duplication counts above.
