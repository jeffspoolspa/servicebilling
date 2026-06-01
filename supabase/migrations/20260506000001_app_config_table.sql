-- Single key/value config table for things that don't justify their own
-- schema. Each row holds a JSONB blob keyed by `key`. UI reads/writes via
-- supabase-js (RLS allows authenticated read; service_role writes).
--
-- First user: ION field mappings (key='ion_field_mappings'). The blob has
-- shape:
--   { "mappings": [
--       { "source_field": "FC",
--         "canonical_table": "chem_readings",
--         "canonical_field": "free_chlorine",
--         "transform": "parse_float" },
--       ...
--     ],
--     "unmapped_fields": [
--       { "source_field": "Phos", "first_seen_at": "...", "sample_values": [...], "occurrence_count": N }
--     ]
--   }
CREATE TABLE IF NOT EXISTS public.app_config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "app_config_authenticated_read" ON public.app_config
  FOR SELECT TO authenticated, anon
  USING (true);

CREATE POLICY "app_config_service_role_write" ON public.app_config
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
