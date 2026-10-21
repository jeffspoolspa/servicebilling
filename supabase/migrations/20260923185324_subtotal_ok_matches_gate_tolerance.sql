-- One fact, one definition (2026-09-23).
--
-- compute_subtotal_ok (the subtotal_ok indicator column) used < 0.02 while the
-- gate — invoice_ready, invoice_gate_checks, compute_billing_status — uses
-- < 0.01. The projection trigger (trg_project_billing_status_on_indicator_change)
-- re-runs only when an indicator CHANGES. So for 8088542: a one-cent QBO edit
-- ($1287.43 -> $1297.43 vs WO $1297.42) flipped the indicator to OK while the
-- gate still said mismatch; the exact edit that followed ($1297.42) satisfied
-- the gate but the indicator was already OK, nothing changed, nothing re-ran,
-- and the invoice sat in needs_review with a stale reason.
--
-- Fix: the indicator uses the gate's tolerance. Exact to the cent is the rule
-- Carter had to satisfy anyway.
create or replace function billing.compute_subtotal_ok(p_qbo_invoice_id text)
returns boolean
language plpgsql
stable
as $$
declare
  v_wo_sub_total     numeric;
  v_invoice_subtotal numeric;
begin
  select subtotal into v_invoice_subtotal
    from billing.invoices where qbo_invoice_id = p_qbo_invoice_id;

  select sub_total into v_wo_sub_total
    from public.work_orders
   where qbo_invoice_id = p_qbo_invoice_id
   order by wo_number limit 1;

  if v_wo_sub_total is null or v_invoice_subtotal is null then
    return null;  -- can't affirm; preserves "unknown"
  end if;

  -- same tolerance as the gate (invoice_ready / invoice_gate_checks /
  -- compute_billing_status): exact to the cent
  return abs(v_wo_sub_total - v_invoice_subtotal) < 0.01;
end;
$$;
