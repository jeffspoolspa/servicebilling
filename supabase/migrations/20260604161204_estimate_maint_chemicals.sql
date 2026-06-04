-- Chemical-estimate gate: one refinable function that returns the per-frequency
-- chemical cost tiers for a given calendar month. The forms/quote engine consume
-- this instead of reading billing_audit.chemical_cost_estimates directly, so the
-- estimate logic (month pick, frequency mapping, 2x/week derivation) lives in one
-- place we can refine without touching every caller.

create or replace function billing_audit.estimate_maint_chemicals(p_calendar_month int)
returns jsonb
language plpgsql
security definer
set search_path = billing_audit, public
as $$
declare
  w_med numeric; w_p25 numeric; w_p75 numeric; w_n int; w_at timestamptz; w_found boolean := false;
  b_med numeric; b_p25 numeric; b_p75 numeric; b_n int; b_at timestamptz; b_found boolean := false;
begin
  select chem_median, chem_p25, chem_p75, sample_size, computed_at
    into w_med, w_p25, w_p75, w_n, w_at
    from chemical_cost_estimates
   where calendar_month = p_calendar_month and service_frequency = 'weekly'
   limit 1;
  w_found := found;

  select chem_median, chem_p25, chem_p75, sample_size, computed_at
    into b_med, b_p25, b_p75, b_n, b_at
    from chemical_cost_estimates
   where calendar_month = p_calendar_month and service_frequency = 'biweekly'
   limit 1;
  b_found := found;

  return jsonb_build_object(
    'month', p_calendar_month,
    'computed_at', coalesce(w_at, b_at),
    'biweekly', case when b_found
      then jsonb_build_object('median', b_med, 'p25', b_p25, 'p75', b_p75, 'sample_size', b_n)
      else null end,
    'weekly', case when w_found
      then jsonb_build_object('median', w_med, 'p25', w_p25, 'p75', w_p75, 'sample_size', w_n)
      else null end,
    -- No empirical 2x/week sample yet: approximate from the weekly tier and flag it.
    -- This is the single place to refine once 2x/week chemical data exists.
    'twice_weekly', case when w_found
      then jsonb_build_object('median', w_med, 'p25', w_p25, 'p75', w_p75, 'sample_size', w_n, 'approximated', true)
      else null end
  );
end;
$$;

-- Public wrapper (rpc() only exposes public). Defaults to the current month.
create or replace function public.estimate_maint_chemicals(
  p_calendar_month int default extract(month from current_date)::int
)
returns jsonb
language sql
security definer
set search_path = public, billing_audit
as $$
  select billing_audit.estimate_maint_chemicals(p_calendar_month);
$$;

grant execute on function public.estimate_maint_chemicals(int) to anon, authenticated, service_role;
