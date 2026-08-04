-- The database enforces what the aggregate promises: ONE charge per
-- idempotency key (invoiceId:cycle). Without this index the upsert had no
-- conflict target and "one charge per cycle" was an application belief, not
-- a fact. Partial: legacy rows without keys are untouched (480 of 544 rows
-- carry keys today, zero duplicates).
CREATE UNIQUE INDEX charges_idempotency_key_uniq ON billing.charges (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
