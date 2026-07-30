-- Input verification moves OUT of the enrichment script and INTO the
-- dispatcher's claim (the invoice_ready-in-CLAIM pattern): a unit is only
-- claimable when the credit cache is provably converged — inbox drained for
-- money entities and the CDC sweep recent. If evidence is red the queue
-- simply waits (inbox drains in seconds; sweep is 15-min) instead of
-- deciding credits on an unproven mirror.
-- Applied 2026-07-24 via MCP apply_migration (recorded 20260724134639).
create or replace function billing.credits_cache_fresh(max_sweep_age_min int default 20)
returns boolean
language sql stable
set search_path to 'billing'
as $$
  select not exists (select 1 from billing.qbo_inbox
                     where finished_at is null and attempts < 3
                       and entity_type in ('Payment','CreditMemo'))
     and exists (select 1 from billing.cdc_cursors
                 where source = 'qbo'
                   and last_run_status in ('succeeded','partial')
                   and last_run_at > now() - make_interval(mins => max_sweep_age_min));
$$;
