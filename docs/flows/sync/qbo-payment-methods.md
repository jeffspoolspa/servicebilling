# Sync Flow: QBO to cached payment methods

> Status: [active]
> Kind: [sync]
> Verification: [stub] — mechanism known, full trace pending
> Leader: QuickBooks Online (cards / ACH on file)
> Cache: [Payment Method](../../entities/payment-method.md)

## What this keeps current

Caches each customer's QBO payment methods (card/ACH on file) so charges don't need a live QBO lookup. Refresh is kicked off when a new invoice lands (a trigger on `billing.invoices` INSERT requests a refresh for that customer) and gated for freshness via `Customers.pm_last_checked_at`.

## The freshness gate (important — this is where the loop happened)

A naive "refresh on every invoice touch" fans out badly: the 4h invoice re-pull touches every invoice row, which fired a per-row PM-refresh request, which looped. The fix (see [pull_customer_payment_methods loop postmortem](../../audits/2026-05-27-database.md)) is an **atomic-claim dedup**: the request trigger only proceeds if `pm_last_checked_at` is null or older than 60 seconds, stamping it in the same UPDATE:

```sql
UPDATE public."Customers" SET pm_last_checked_at = now()
 WHERE qbo_customer_id = NEW.qbo_customer_id
   AND (pm_last_checked_at IS NULL OR pm_last_checked_at < now() - interval '60 seconds');
IF NOT FOUND THEN RETURN NEW; END IF;  -- already claimed recently, skip
```

> This is a stub. Fill in: the script (`f/service_billing/pull_customer_payment_methods.py`), exact target table/columns, the pg_net trigger that requests the refresh, and the webhook channel if any.

## Cross-references

- Entity: [Payment Method](../../entities/payment-method.md)
- Indicator trigger: [set_payment_method_ok](../../scripts/_triggers/set_payment_method_ok.md)
- Postmortem: [2026-05-27-database](../../audits/2026-05-27-database.md)
- Downstream: [work-order-to-payment](../work-order-to-payment.md)
