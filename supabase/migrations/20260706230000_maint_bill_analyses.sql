-- AI bill-analysis results for the review workbench. One row per
-- customer-month, overwritten on re-run (the workbench shows the latest).
-- Written by f/billing/analyze_maint_bill (service_role via direct SQL);
-- read by the app through the definer RPC below (billing_audit is not
-- PostgREST-exposed).
CREATE TABLE billing_audit.maint_bill_analyses (
  customer_id   bigint NOT NULL,
  billing_month date   NOT NULL,
  result        jsonb  NOT NULL,  -- {driver, normal, recommend}
  model         text,
  usage         jsonb,            -- token counts incl. cache hits (cost visibility)
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, billing_month)
);

create or replace function public.maint_billing_bill_analysis(
  p_customer_id bigint,
  p_month date
)
returns table (result jsonb, model text, created_at timestamptz)
language sql stable security definer
set search_path = billing_audit, public
as $$
  select a.result, a.model, a.created_at
  from billing_audit.maint_bill_analyses a
  where a.customer_id = p_customer_id and a.billing_month = p_month;
$$;

revoke all on function public.maint_billing_bill_analysis(bigint, date) from public, anon;
grant execute on function public.maint_billing_bill_analysis(bigint, date) to authenticated, service_role;
