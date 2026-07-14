-- Real-time push of new app follow-up submissions to Airtable.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- The daily reconcile (20260714165618) moved everything to once-a-day, but new
-- app submissions must reach Airtable immediately so the office sees them
-- (they still triage there during migration). This re-adds a wake trigger, but
-- GUARDED: it fires only for genuine new app rows (airtable_record_id IS NULL
-- AND source = 'app'). Backfill/ingest rows carry a record id and a non-'app'
-- source, so a bulk import can never flood the queue again (as it did with the
-- original unguarded trigger). The daily job still pushes as a backstop for any
-- pg_net drop, and f/maintenance/backfill_follow_ups_from_airtable runs with
-- concurrent_limit=1 so two quick submissions can't double-create.

create or replace function maintenance.fn_wake_follow_up_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_token text;
  v_url constant text :=
    'https://app.windmill.dev/api/w/jps-internal/jobs/run/p/f/maintenance/backfill_follow_ups_from_airtable';
begin
  if new.airtable_record_id is not null or new.source is distinct from 'app' then
    return new;
  end if;
  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'windmill_token' limit 1;
  if v_token is null then
    return new;
  end if;
  perform net.http_post(
    url     := v_url,
    body    := '{"mode":"push"}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    timeout_milliseconds := 5000
  );
  return new;
end;
$function$;

drop trigger if exists follow_ups_push_on_insert on maintenance.follow_ups;
create trigger follow_ups_push_on_insert
  after insert on maintenance.follow_ups
  for each row execute function maintenance.fn_wake_follow_up_push();

do $$
begin
  if not exists (select 1 from pg_trigger where tgname='follow_ups_push_on_insert') then
    raise exception 'push trigger not created';
  end if;
end $$;
