-- Service-billing pre-process: move the DECISION off billing.invoices columns
-- onto a dedicated pre-process row + credit decision record, derive in a view.
--
-- Why (ADR 009 / DATA_WRITE_MODEL): billing.invoices is the QBO mirror. Today
-- pre_process_invoice.write_result STAMPS six app-owned decision columns onto
-- it (payment_method, preferred_payment_type, target_payment_method_id,
-- qbo_class, memo, credits_applied). Those are decisions, not QBO facts, and
-- they belong on a pre-process row whose STATE gates ready_to_process. Every
-- credit CONSIDERED for an invoice becomes a decision row (the frozen
-- candidate snapshot); applied reality stays in payment_invoice_links.
--
-- This migration is ADDITIVE. It creates the tables + a read view. The writer
-- (pre_process_invoice) and the status projection move over in a follow-up;
-- the stamped invoice columns are dropped only AFTER that, in a later
-- migration, once nothing reads them. Two-phase on purpose.
--
-- Assumes billing.invoices(qbo_invoice_id) is unique (it is — every echo/read
-- path keys on it). Verify before apply if unsure.

-- 1. the decision / gate row -------------------------------------------------
-- One row per invoice-cycle. state is the machine that gates the charge queue.
-- *_verified_at are the freshness PROVENANCE: the fetched_at we decided on, so
-- ready_to_process provably means "decided on data verified fresh as of T".

create table if not exists billing.invoice_pre_process (
  qbo_invoice_id      text primary key
                        references billing.invoices(qbo_invoice_id) on delete cascade,
  state               text not null default 'deciding'
                        check (state in ('deciding','ready_to_process','processed','needs_review')),
  credits_verified_at timestamptz,   -- when THIS decision last read credits fresh from QBO
  pm_verified_at      timestamptz,   -- when THIS decision last read payment methods fresh
  reviewed_at         timestamptz,   -- when review (auto or human) completed
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- 2. the credit decision record ----------------------------------------------
-- One row per (invoice, credit CONSIDERED) — the snapshot-in-time context of
-- what open credits existed when this invoice pre-processed and what happened
-- to each (Carter 2026-07-22). EVERY open credit the matcher saw gets a row,
-- not just matches: reason non-null = auto-recommended, null = seen but not
-- recommended (available for manual pick).
--
-- Lifecycle: candidate -> applied | rejected | stale. Terminal rows are
-- HISTORY, never rewritten — current truth lives in customer_payments +
-- payment_invoice_links. Open (candidate) rows are maintained against reality
-- by refresh_payment (the payment single-writer): external application to
-- this invoice -> 'applied' (applied_via='external_qbo'); credit consumed
-- elsewhere / no longer covered -> 'stale'. Review-complete closes remaining
-- candidates as 'rejected' (decided_by='review_complete') so every row ends
-- with an outcome. Gate to ready_to_process: no rows still 'candidate'.

create table if not exists billing.invoice_credit_decisions (
  id                    bigint generated always as identity primary key,
  qbo_invoice_id        text not null
                          references billing.invoice_pre_process(qbo_invoice_id) on delete cascade,
  credit_id             text not null,   -- billing.customer_payments.qbo_payment_id (QBO identity)
  amount                numeric not null,           -- amount proposed/applied to THIS invoice
  unapplied_at_decision numeric,                    -- what the matcher saw, frozen
  state                 text not null default 'candidate'
                          check (state in ('candidate','applied','rejected','stale')),
  reason                text,            -- match reason (auto-recommended) | null (considered only)
  decided_by            text,            -- 'auto' | user id | 'review_complete' | 'external_qbo'
  applied_via           text,            -- 'pre_process' | 'manual' | 'external_qbo'
  created_at            timestamptz not null default now(),
  decided_at            timestamptz,
  applied_at            timestamptz,
  unique (qbo_invoice_id, credit_id)
);

create index if not exists invoice_credit_decisions_open
  on billing.invoice_credit_decisions (qbo_invoice_id)
  where state = 'candidate';

-- resolve open candidates when a payment's reality changes (refresh_payment)
create index if not exists invoice_credit_decisions_by_credit
  on billing.invoice_credit_decisions (credit_id)
  where state = 'candidate';

-- 3. read view: the decision state + credit rollup, joined to the mirror -----
-- Additive surface for the UI/worker to see the gate condition. It does NOT
-- yet replace billing_status — that projection move is the next step. For now
-- it exposes the pending-credit gate and the freshness provenance so the
-- worker/UI can reason about ready_to_process without touching the invoice
-- columns.

create or replace view billing.v_service_billing_state as
select
  i.qbo_invoice_id,
  i.qbo_customer_id,
  i.balance,
  i.fetched_at                         as invoice_verified_at,
  pp.state                             as pre_process_state,
  pp.credits_verified_at,
  pp.pm_verified_at,
  pp.reviewed_at,
  coalesce(sel.open_count, 0)          as open_candidate_count,
  coalesce(sel.open_count, 0) = 0      as credits_settled,   -- the gate half
  coalesce(sel.applied_amount, 0)      as credits_applied_amount
from billing.invoices i
left join billing.invoice_pre_process pp using (qbo_invoice_id)
left join lateral (
  select
    count(*) filter (where state = 'candidate')                      as open_count,
    coalesce(sum(amount) filter (where state = 'applied'), 0)        as applied_amount
  from billing.invoice_credit_decisions s
  where s.qbo_invoice_id = i.qbo_invoice_id
) sel on true;
