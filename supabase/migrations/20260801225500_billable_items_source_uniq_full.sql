-- ON CONFLICT (source_id) cannot target a partial unique index. A full unique
-- index enforces the same I-B1 (Postgres unique ignores NULLs, so the flat
-- rows' NULL source_id never conflicts) and is upsert-addressable.
DROP INDEX billing.billable_items_source_uniq;
CREATE UNIQUE INDEX billable_items_source_uniq ON billing.billable_items (source_id);
