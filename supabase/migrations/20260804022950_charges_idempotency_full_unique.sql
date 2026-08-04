-- The partial predicate made the index invisible to ON CONFLICT
-- (idempotency_key). A FULL unique index arbitrates the upsert; NULLs stay
-- distinct, so the legacy rows without keys are unaffected.
-- [found live: ABOLT pilot's first collect failed at the charge SAVE with
-- 42P10 after the processor call — the exact crash window the ladder's
-- Request-Id convergence is built for.]
DROP INDEX IF EXISTS billing.charges_idempotency_key_uniq;
CREATE UNIQUE INDEX charges_idempotency_key_uniq ON billing.charges USING btree (idempotency_key);
