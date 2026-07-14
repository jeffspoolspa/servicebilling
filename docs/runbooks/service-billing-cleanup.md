# Runbook: service-billing cleanup (ADR 009 applied)

> Status: [active]
> Executable plan to (1) delete dead service-billing code and (2) refactor the
> live path onto the shared `_lib`, per
> [LIBRARY_COMPOSITION.md](../conventions/LIBRARY_COMPOSITION.md) +
> [ADR 009](../adrs/009-shared-qbo-primitives-lib.md).
> Deploy every step via [WINDMILL_DEPLOY.md](../conventions/WINDMILL_DEPLOY.md)
> (REST API — the MCP connector is scoped to the wrong workspace).
> All money-code steps: deploy + dry-run verify before a live run.

## Live audit (evidence — verified 2026-07-10 via REST job history)

| Script | Runs since Mar | Last run | Verdict |
|---|---|---|---|
| `f/service_billing/process_invoice` | 45 | 2026-07-09 | LIVE (app-triggered, WAL-based) |
| `f/service_billing/pre_process_invoice` | 100 | 2026-07-09 | LIVE |
| `f/service_billing/process_work_order` | 0 | none | DEAD (no runs, no trigger, no flow ref) |
| `f/service_billing/service_billing_processing` | 0 | none | DEAD (legacy Google-Sheets path) |
| `f/billing/monthly_autopay` (flow) | last 2026-06-02 | — | DEAD (superseded by `process_maint_period`) |

Re-verify counts before deleting (`jobs/list?script_path_exact=<path>&created_after=...`).

## Phase 0 — DELETE dead code (biggest, safest win: ~2000 lines)

Delete the scripts (repo + Windmill). **Keep the historical DB tables.**

```bash
set -a; source .env.local; set +a
API="${WINDMILL_BASE_URL%/}"; WS="$WINDMILL_WORKSPACE"; AUTH="Authorization: Bearer $WINDMILL_TOKEN"
for p in f/service_billing/process_work_order \
         f/service_billing/service_billing_processing \
         f/billing/monthly_autopay ; do
  curl -s -w "  <- HTTP %{http_code}\n" -X POST -H "$AUTH" "$API/w/$WS/scripts/delete/p/$p"
done
# repo side:
git rm f/service_billing/process_work_order.py f/service_billing/process_work_order.script.yaml \
       f/service_billing/service_billing_processing.py
git rm -r f/billing/monthly_autopay.flow    # confirm the exact flow path first
```

**Do NOT drop tables** — `billing.autopay_transactions` (951 rows),
`autopay_events` (6,186), `billing_runs` (4) are the historical charge record
(Mar–Jun 2026). Retire the writers; keep the ledger. (`monthly_autopay` is
already marked retired in SYSTEM_MAP §3.4.)

Also sweep `u/carter/*` scratch flagged in the July audit (`tmp_*`, the
`effective/rightful/stylish/monumental_script.py` placeholders, stale
`get_*`/`backfill_*`, `u/carter/monthly_autopay_processing.flow`). Verify each
has 0 recent runs first.

## Phase 1 — build the shared `_lib` (deploy + self-check each)

Per ADR 009 §5, in order. Contracts in the ADR 009 addendum.

- [x] `f/billing/_lib/db` — `get_db_conn` (DONE, deployed 2026-07-10, hash f143e17d)
- [ ] `f/billing/_lib/qbo` — already has charge/classify/send/read primitives;
      add `refresh_qbo_token` (its own pass, 22 sites) + generic `qbo_get`/`qbo_post`
- [ ] `f/billing/_lib/wal` — `create_attempt`/`update_attempt`/`latest_attempt`
- [ ] `f/billing/_lib/payments`:
  - `charge_and_record(conn, intent, at, rid, dry_run)` — WAL + fresh-read +
    charge + payment + best-effort receipt (contract: ADR 009 §B)
  - `apply_credits(conn, invoice_id, customer_id, at, rid, dry_run)` — the second
    service (shared by invoice + WO): apply available credits in QBO, lowering the
    balance the charge then reads fresh
  - `resolve_payment_method(conn, customer_id)` — active card/ACH (from the 3
    divergent `get_active_payment_method`/`get_customer_payment_method` copies)
- Each carries a `__main__` self-check (money code); review as a money change.

## Phase 2 — refactor `process_invoice` onto `_lib` (the one live script)

Tier every function (locations from the July audit):

| Current (in `process_invoice.py`) | Action |
|---|---|
| `refresh_qbo_token`, `qbo_get/post`, `fetch_qbo_*`, `charge_*`, `_classify_charge_response`, `extract_charge_error`, `record_qbo_payment`, `send_invoice_email`, `send_payment_receipt`, `get_db_conn` | delete local → import from `_lib/qbo` + `_lib/db` |
| `create_attempt`, `update_attempt`, `latest_process_attempt`, `insert_webhook_expectation` | move into `_lib/wal` + `charge_and_record` |
| `load_applicable_credits` + credit-apply flow | move into `apply_credits` service |
| `get_active_payment_method`, `load_payment_method_by_id`, `_pm_row_to_result` | move into `resolve_payment_method` |
| `refresh_invoice_cache` | route through the single-writer cache upsert (ADR 008) |
| `mark_invoice_processed`, `mark_invoice_needs_review` | delete → derive (Phase 3) |
| `process_one` (320 ln), `_process_charge_path` (217), `_process_invoice_only`, `_retry_record_payment_for_orphan`, `_build_dry_run_plan` | collapse to a ~10-line `process()` sentence + `build_intent`/`deliver` |

Target shape: the event-handler in
[LIBRARY_COMPOSITION.md](../conventions/LIBRARY_COMPOSITION.md#reference-a-workflow-as-an-event-handler)
(invoice keys on `qbo_invoice_id` instead of `wo_number`). ~1625 lines → a few hundred.

Order: get_db_conn swap first (proven, zero-risk) → qbo primitives → wal + services
→ collapse the sentence. Dry-run verify after each deploy; `process_invoice` is the
live charge path (`/api/billing/process`).

## Phase 3 — derive invoice status  [DONE 2026-07-13]

`billing.v_invoice_status` (migration `20260713100000`) is the rules home:
processed = paid AND sent; sent + open balance = `open_ar` (new bucket — 92
invoices surfaced on day one that were stamped processed with money
outstanding); in-flight attempts never reclassify. The tab views
(`v_billing_queue`/`v_needs_attention`/`v_processed`) + `v_open_ar` read the
derivation; `process_invoice` dropped `mark_invoice_processed` and gates on
`derived_status`. `mark_invoice_needs_review` stays (records the halt reason).
Statuses are CONTEXTUAL by design: other contexts define their own reading
over the same facts (maintenance: delivered-without-charge = period done).

## Fix the doc drift while here

SYSTEM_MAP §domain still lists `process_work_order` as a live service-billing
script — mark it retired alongside the delete (this branch already does).

## Sequencing summary

Phase 0 (delete) can land immediately — it's pure removal of dead code. Phases
1–3 are the ADR 009 §5 sequence and touch the live charge path, so each is
deploy-then-dry-run-verify. Do the `get_db_conn` swap across live scripts first
as the warm-up (mechanic already proven).


## Phase 4 — pre_process_invoice onto _lib  [DONE 2026-07-13]

928 -> 642 lines (~100 of which are the memo prompt/examples — policy). All
QBO plumbing deleted -> `_lib/qbo` (`update_invoice_sparse`, cached
`fetch_qbo_classes`, `apply_credit`); credit APPLY + echoes (unapplied_amt
decrement, payment_invoice_links upsert) -> `_lib/payments.apply_credits`
(caller-picked `credits` list); cache write -> `_lib/cache.echo_invoice`.
Kept as sentences: the WO credit matcher, route resolution, class derivation,
memo generation (deterministic + LLM + O'Brien guard). New guard: invoices
whose DERIVED status is processed/open_ar are terminal for enrichment — never
rewrite a memo the customer already received. Per-caller 429 retry dropped;
the shared token bucket (ADR 008 §4) is the structural replacement [pending].

## End-state for billing_status (decided 2026-07-13)

The column drops when three criteria hold, audited in order:
1. every stamped stage is a recorded FACT elsewhere (pre_processed_at,
   the *_ok indicators, override timestamps, attempts) — done for terminal
   states, pipeline stages still write the column;
2. `v_invoice_status` derives every stage and all readers (app views,
   check_buddy, report SQL, other repos) sit on views — reader audit pending;
3. writers reach zero (engines done; pre_process + sync + triggers remain).
Until then the column is the pipeline-stage record, not "the status".


## Phase 5 — attempt/charge split  [decided 2026-07-13, not started]

Per [entities/processing-attempt.md](../entities/processing-attempt.md)
target model: (a) narrow `processing_attempts` to charge attempts only —
`process_invoice` drops its email/halt/stub rows once the WO timeline reads
the queue + facts instead (bundle with the Open AR tab wiring); (b) split the
Intuit charge event into `billing.charges` (reflection of the leader's fact,
keyed by charge_id) referenced from the attempt row; `reconcile_payments`
becomes a writer of that reflection. Do (a) before (b) — (b) is a schema
change reviewed as money code.

## Derivation gap noted 2026-07-14: voided invoices

`derived_status` has no 'voided' terminal state — a voided $0 invoice reads
'processed' (balance 0 + sent) and voided unpaid ones lean on the stamped
needs_review_reason='invoice_voided'. Add a void fact check (QBO payload) to
`v_invoice_status` as its own terminal state in the next view pass; takes the
hidden needs_review noise from 12 -> 3.

## Write-time echo contract  [DONE 2026-07-14]

Every QBO write's RESPONSE body is a free verified echo — committed to the
cache synchronously by the writer (ADR 009 §C generalized; Carter 2026-07-14).
Webhooks/CDC demote to changes-not-made-by-us + delivery telemetry; the
inbox's supersession check moot-finishes our own writes' webhooks
automatically (echo bumps fetched_at first — no ours-vs-theirs flag needed).

- cache.echo_payment: OCC-guarded upsert (leader LastUpdatedTime) from the
  payment-create / credit-apply response; wired into charge_and_record and
  apply_credits. The payment cache shows a charge at COMMIT time, not
  webhook time.
- apply_credits payment-credit path now echoes the response's TRUE
  UnappliedAmt (was a computed GREATEST() decrement — a write-what-you-can-
  prove violation, fixed).
- CROSS-ENTITY RIPPLES stay honest: a write response describes only the
  entity written. Invoice balance after a charge = one fresh read (kept);
  credit memo remaining after a CM apply = computed + flagged, converged by
  pull_qbo_credits/CDC; customer AR = derived (no cache at all). Never
  compute-and-write.
- webhook_expectations demote to telemetry (they measured the 97%/100%
  delivery matrix) — stop paging on 'missing' for echo-confirmed writes.
