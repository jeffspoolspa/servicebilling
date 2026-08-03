-- The invoice MACHINE's own state lives on the issued-document row (RULED:
-- after creation the invoice runs its own machine; the month only tracks).
-- preprocessed_at + the linked instrument are the credit-check step's
-- answer; sent-ness is read from the invoice mirror (email_status), paid
-- from balance — both fed by echoes and webhooks.
ALTER TABLE billing.month_invoices ADD COLUMN preprocessed_at timestamptz;
ALTER TABLE billing.month_invoices ADD COLUMN linked_payment_method_id text;
GRANT UPDATE (preprocessed_at, linked_payment_method_id) ON billing.month_invoices TO service_role;
