-- RULED: ION's task billing type is the DEFAULT; when a customer's tasks
-- disagree, the month holds at the gate and a person chooses. The choice
-- lives here, per month.
alter table billing.billing_months add column if not exists doc_settings_override jsonb;
