-- Phase 2A.3: Bootstrap triggers — fire on the linking event from either
-- side of the work_orders ↔ billing.invoices relationship.
--
-- The "linking event" is when a billable, non-skipped WO becomes
-- associated with a billing.invoices row. This event can be observed:
--   Side A: work_orders INSERT or UPDATE making the row qualify
--   Side B: billing.invoices INSERT where a qualifying WO already exists
--
-- bootstrap_indicators is idempotent — re-running on an already-bootstrapped
-- invoice just rewrites the same values. So if both sides fire (rare race
-- where the two events land in close succession), the result is a no-op
-- second UPDATE.

------------------------------------------------------------------------------
-- Side A: work_orders → infer linkage from this side
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.fn_bootstrap_indicators_on_wo_link()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.qbo_invoice_id IS NULL
     OR NEW.billable IS NOT TRUE
     OR NEW.skipped_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- For UPDATE: skip if OLD already qualified with the SAME invoice. We
  -- only want to bootstrap on the transition into the pipeline, not on
  -- every routine ION rescrape that touches an already-linked row.
  IF TG_OP = 'UPDATE'
     AND OLD.qbo_invoice_id = NEW.qbo_invoice_id
     AND OLD.billable IS TRUE
     AND OLD.skipped_at IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM billing.bootstrap_indicators(NEW.qbo_invoice_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bootstrap_indicators_on_wo_link ON public.work_orders;
CREATE TRIGGER trg_bootstrap_indicators_on_wo_link
AFTER INSERT OR UPDATE OF qbo_invoice_id, billable_override, skipped_at, schedule_status
ON public.work_orders
FOR EACH ROW
EXECUTE FUNCTION billing.fn_bootstrap_indicators_on_wo_link();

------------------------------------------------------------------------------
-- Side B: billing.invoices INSERT — invoice arrives after WO already linked
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.fn_bootstrap_indicators_on_invoice_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- bootstrap_indicators internally early-exits if no qualifying WO exists,
  -- so this trigger is safe to fire on every INSERT.
  PERFORM billing.bootstrap_indicators(NEW.qbo_invoice_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bootstrap_indicators_on_invoice_insert ON billing.invoices;
CREATE TRIGGER trg_bootstrap_indicators_on_invoice_insert
AFTER INSERT ON billing.invoices
FOR EACH ROW
EXECUTE FUNCTION billing.fn_bootstrap_indicators_on_invoice_insert();
