-- Balance integrity probe (Carter 2026-07-14): our cache should hold ALL of
-- an invoice balance's input entities (payments now, credit memos join the
-- CDC probe this change; journal entries / deposits added when evidence
-- demands). The DERIVED balance (total minus the applications we hold) is
-- the completeness model; QBO's REPORTED balance is the integrity check.
-- A mismatch never "fixes" a balance — it means an application entity is
-- missing from the cache (or an input type we don't model yet touched the
-- invoice) and belongs in the inbox. Money decisions keep deciding on the
-- fresh leader read regardless (ADR 008 §6).

create or replace view billing.v_invoice_balance_integrity as
with apps as (
  select lt.value ->> 'TxnId' as qbo_invoice_id,
         sum((line.value ->> 'Amount')::numeric) as applied
  from billing.customer_payments p
  cross join lateral jsonb_array_elements(coalesce(p.raw -> 'Line', '[]'::jsonb)) line
  cross join lateral jsonb_array_elements(coalesce(line.value -> 'LinkedTxn', '[]'::jsonb)) lt
  where lt.value ->> 'TxnType' = 'Invoice'
  group by 1
)
select i.qbo_invoice_id,
       i.doc_number,
       i.total_amt,
       i.balance                                          as leader_balance,
       round(coalesce(a.applied, 0), 2)                   as applied_known,
       round(i.total_amt - coalesce(a.applied, 0), 2)     as derived_balance,
       round(abs(i.balance - (i.total_amt - coalesce(a.applied, 0))), 2) as diff,
       abs(i.balance - (i.total_amt - coalesce(a.applied, 0))) > 0.01    as mismatch,
       i.fetched_at
from billing.invoices i
left join apps a using (qbo_invoice_id)
where i.total_amt is not null and i.balance is not null;

create or replace view public.v_invoice_balance_integrity as
  select * from billing.v_invoice_balance_integrity;
grant select on public.v_invoice_balance_integrity to anon, authenticated, service_role;
