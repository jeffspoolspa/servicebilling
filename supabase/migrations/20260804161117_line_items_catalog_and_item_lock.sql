-- Applied then partially superseded in the same session: the catalog table
-- created here was DROPPED by 20260804161235 (misread requirement — see
-- that migration). What SURVIVES from this migration is the ITEM LOCK:
-- billable items become immutable once their invoice link is set.
CREATE OR REPLACE FUNCTION billing.billable_item_lock()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.qbo_invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'billable item % is locked by invoice % — items on an issued invoice do not change', OLD.id, OLD.qbo_invoice_id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.qbo_invoice_id IS NOT NULL THEN
    IF NEW.item_name IS DISTINCT FROM OLD.item_name
       OR NEW.qty IS DISTINCT FROM OLD.qty
       OR NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
       OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.task_id IS DISTINCT FROM OLD.task_id
       OR NEW.service_date IS DISTINCT FROM OLD.service_date
       OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.billing_month_id IS DISTINCT FROM OLD.billing_month_id
       OR NEW.task_terms_id IS DISTINCT FROM OLD.task_terms_id
       OR NEW.qbo_invoice_id IS DISTINCT FROM OLD.qbo_invoice_id THEN
      RAISE EXCEPTION 'billable item % is locked by invoice % — items on an issued invoice do not change', OLD.id, OLD.qbo_invoice_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_billable_item_lock ON billing.billable_items;
CREATE TRIGGER trg_billable_item_lock
  BEFORE UPDATE OR DELETE ON billing.billable_items
  FOR EACH ROW EXECUTE FUNCTION billing.billable_item_lock();
