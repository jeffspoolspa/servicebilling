-- Service-billing pre-process: move the DECISION off billing.invoices columns
-- onto a dedicated decision row + selection table, and derive state in a view.
--
-- Why (ADR 009 / DATA_WRITE_MODEL): billing.invoices is the QBO mirror. Today
-- pre_process_invoice.write_result STAMPS six app-owned decision columns onto
-- it (payment_method, preferred_payment_type, target_payment_method_id,
-- qbo_class, memo, credits_applied). Those are decisions, not QBO facts, and
-- they belong on a pre-process row whose STATE gates ready_to_process. Credits
-- selected for an invoice live as rows here (candidates come from the derived
-- billing_open_credits view; applied reality lives in payment_invoice_links).
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

-- 2. the credit decisions ----------------------------------------------------
-- One row per credit considered for this invoice. state, not deletion, carries
-- history: a credit applied in QBO becomes 'applied' (keeps the audit); a user
-- deselect becomes 'removed'. The gate to ready_to_process is "no rows still
-- 'pending'" — an empty PENDING list, not an empty table.

create table if not exists billing.invoice_credit_selections (
  id             bigint generated always as identity primary key,
  qbo_invoice_id text not null
                   references billing.invoice_pre_process(qbo_invoice_id) on delete cascade,
  credit_id      text not null,       -- billing.customer_payments.qbo_payment_id (QBO identity)
  amount         numeric not null,
  state          text not null default 'pending'
                   check (state in ('pending','applied','removed')),
  reason         text,                -- match reason (auto) or null (manual pick)
  selected_by    text not null default 'auto',  -- 'auto' | a user id
  selected_at    timestamptz not null default now(),
  applied_at     timestamptz,
  unique (qbo_invoice_id, credit_id)
);

create index if not exists invoice_credit_selections_pending
  on billing.invoice_credit_selections (qbo_invoice_id)
  where state = 'pending';

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
  coalesce(sel.pending_count, 0)       as pending_credit_count,
  coalesce(sel.pending_count, 0) = 0   as credits_settled,   -- the gate half
  coalesce(sel.applied_amount, 0)      as credits_applied_amount
from billing.invoices i
left join billing.invoice_pre_process pp using (qbo_invoice_id)
left join lateral (
  select
    count(*) filter (where state = 'pending')                        as pending_count,
    coalesce(sum(amount) filter (where state = 'applied'), 0)        as applied_amount
  from billing.invoice_credit_selections s
  where s.qbo_invoice_id = i.qbo_invoice_id
) sel on true;
