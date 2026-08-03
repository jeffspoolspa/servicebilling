-- The month gate's context reads: service_role bypasses RLS but still needs
-- table-level GRANTs, and autopay_customers never had one. Applied via MCP.
grant select on billing.autopay_customers to service_role;
grant select on billing.customer_payment_methods to service_role;
grant select on billing.holds to service_role;
grant select on billing.customer_payments to service_role;
grant select on billing.findings to service_role;
