# f/service_billing/probe_balance_integrity

> Status: [active]
> Source: [f/service_billing/probe_balance_integrity.py](../../../f/service_billing/probe_balance_integrity.py)
> Triggered by: manual / after sweeps (schedule [pending scope])
> Concurrency: `qbo_api` (limit 1)

## Purpose

The ledger-healing probe. "Healed" means the DERIVED invoice balance
(`billing.v_invoice_balance_integrity`: total minus the applications our
cache holds) converges to the leader's reported balance because the INPUT
ENTITIES became complete — never because a number was copied. QBO's balance
is the integrity check, not a sync target; money decisions still decide on
fresh leader reads (ADR 008 §6).

## What a run does

For each mismatched invoice (largest diff first, `limit` per run):

1. Fetch the invoice fresh; walk its `LinkedTxn` — QBO lists every
   transaction applied to it, i.e. the ids we cannot know locally.
2. **Forward diff**: linked Payments/CreditMemos our cache lacks are
   enqueued into `billing.qbo_inbox` (`source='probe'`).
3. **Reverse diff**: applications our cache holds that the leader no longer
   lists (deleted-and-reentered payments) are enqueued too — their refresh
   discovers the deletion and the mirror row is removed.
4. Unmodeled `TxnType`s (JournalEntry, Deposit, ...) are logged to
   `drift_log` as `kind='unmodeled_application'` — the evidence ledger for
   which entity class earns cache status next.
5. The invoice itself is enqueued (cheap, coalesced) so its snapshot is
   fresh for the next integrity read.

Read + enqueue only — the inbox drainer does all healing.

## First live run (2026-07-14)

8 mismatches / $85,050 diff -> ZERO mismatches across all 3,719 cached
invoices after three probe rounds: 4 were plain
uncached Payments (incl. two $40k+ commercial halves), 4 were dead payments
double-counting (exposed the QBO gotcha that deleted transactions read back
400 "Object Not Found", not 404 — refresh_payment's mirror-delete now
handles both). Zero unmodeled types: JournalEntry/Deposit do NOT earn
entity status on current evidence.
