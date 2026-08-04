-- The Charge aggregate's ladder vocabulary (requested -> settled ->
-- recorded -> receipted; declined) joins the legacy terms. A settled
-- charge's save MUST never be refused — money facts are written in the
-- order they became true.
ALTER TABLE billing.charges DROP CONSTRAINT charges_status_vocabulary;
ALTER TABLE billing.charges ADD CONSTRAINT charges_status_vocabulary
  CHECK (status = ANY (ARRAY[
    'succeeded','declined','error','uncertain',           -- legacy vocabulary
    'requested','settled','recorded','receipted','captured' -- the ladder + live machinery
  ]));
