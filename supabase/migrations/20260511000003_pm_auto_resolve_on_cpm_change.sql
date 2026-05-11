-- Closes the "new card added in QBO but invoice still says email" gap.
--
-- Two parts in one transaction (order matters — backfill MUST precede
-- trigger so existing manual triage edits don't get auto-overwritten the
-- moment any cpm change fires the trigger):
--
-- 1. Backfill preferred_payment_type_overridden_at from attempts_unblocked_at
--    for invoices that show a post-pre_process user PM edit
--    (attempts_unblocked_at > pre_processed_at + 1s). Pre_process's own
--    initial PM write also stamps attempts_unblocked_at, but it does so AT
--    pre_processed_at — the timing differential separates "system wrote
--    initial value" from "user edited later via triage".
--
--    Required because the triage classification editor (push_invoice_edits)
--    historically wrote payment_method without stamping the override
--    column, so we have no canonical record of which invoices the user
--    intentionally pinned to email-only / a specific card. Heuristic from
--    timestamps is the best we can reconstruct.
--
--    Going forward: push_invoice_edits is patched to stamp the override
--    column directly when payment_method actually changes. So this
--    backfill only covers the historical gap.
--
-- 2. fn_resolve_pm_on_cpm_change — fires on customer_payment_methods
--    INS / UPDATE OF (is_active, is_default) / DELETE. For each linked,
--    billable, non-skipped, non-processed, non-overridden invoice for the
--    affected customer, re-resolves payment_method via
--    resolve_preferred_payment_type + pick_target_payment_method and
--    writes back if any of (payment_method, preferred_payment_type,
--    target_payment_method_id) actually changed.
--
--    Cascade after the UPDATE on billing.invoices:
--      BEFORE fn_set_attempts_unblocked_at_on_pm_change → stamps timestamp,
--             clears any prior charge_declined block (correct since we're
--             switching configs).
--      AFTER  fn_set_payment_method_ok_from_invoice → recomputes
--             payment_method_ok (usually no change — both new and old
--             configs settle the channel — but covers the edge cases).
--      fn_project_billing_status_on_indicator_change → projects status.
--
--    Net effect: a card change in QBO automatically threads through to
--    every eligible invoice for that customer. invoices that were
--    email-only because no card existed at pre_process time will switch
--    to charging the new card. Invoices that were charging a card that
--    just got deactivated will fall back to email.

------------------------------------------------------------------------------
-- Step 1: backfill manual-override timestamps for triage-edited invoices
------------------------------------------------------------------------------

UPDATE billing.invoices
   SET preferred_payment_type_overridden_at = attempts_unblocked_at
 WHERE preferred_payment_type_overridden_at IS NULL
   AND attempts_unblocked_at IS NOT NULL
   AND pre_processed_at IS NOT NULL
   AND attempts_unblocked_at > pre_processed_at + interval '1 second';

------------------------------------------------------------------------------
-- Step 2: the auto-resolve trigger
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.fn_resolve_pm_on_cpm_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_customer_id   text := COALESCE(NEW.qbo_customer_id, OLD.qbo_customer_id);
  v_inv           record;
  v_new_preferred text;
  v_new_target    uuid;
  v_new_pm        text;
BEGIN
  IF v_customer_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  FOR v_inv IN
    SELECT i.qbo_invoice_id,
           i.payment_method,
           i.target_payment_method_id,
           i.preferred_payment_type,
           w.work_description
      FROM billing.invoices i
      JOIN public.work_orders w ON w.qbo_invoice_id = i.qbo_invoice_id
     WHERE i.qbo_customer_id = v_customer_id
       AND i.billing_status != 'processed'
       AND i.preferred_payment_type_overridden_at IS NULL
       AND w.billable    = true
       AND w.skipped_at IS NULL
  LOOP
    v_new_preferred := billing.resolve_preferred_payment_type(
      v_customer_id, v_inv.work_description
    );
    v_new_target    := billing.pick_target_payment_method(
      v_customer_id, v_new_preferred
    );
    v_new_pm        := CASE WHEN v_new_preferred = 'email'
                              THEN 'invoice' ELSE 'on_file'
                       END;

    IF v_inv.payment_method            IS DISTINCT FROM v_new_pm
       OR v_inv.target_payment_method_id IS DISTINCT FROM v_new_target
       OR v_inv.preferred_payment_type   IS DISTINCT FROM v_new_preferred THEN
      UPDATE billing.invoices
         SET payment_method            = v_new_pm,
             target_payment_method_id  = v_new_target,
             preferred_payment_type    = v_new_preferred
       WHERE qbo_invoice_id = v_inv.qbo_invoice_id;
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_resolve_pm_on_cpm_change ON billing.customer_payment_methods;
CREATE TRIGGER trg_resolve_pm_on_cpm_change
AFTER INSERT OR UPDATE OF is_active, is_default OR DELETE
ON billing.customer_payment_methods
FOR EACH ROW
EXECUTE FUNCTION billing.fn_resolve_pm_on_cpm_change();
