-- Applied via MCP 2026-10-15 as onboarding_context_floor.
-- onboarding context floor: candidate hiring pipeline (Calendly booking ->
-- interview scorecard -> outcome emails; later phases add documents,
-- approvals, Marsh/Gusto/Samsara). Owner: onboarding module (lib/onboarding).
-- See docs/conventions/SCHEMA_OWNERSHIP.md and docs/flows/candidate-onboarding.md.
--
-- Holds hiring PII (names, contact info; later DOB/DL#). Backend schema:
-- service_role only, RLS on every table with no policies. UI reads go
-- through server code that has already checked the onboarding staff
-- allowlist (lib/onboarding/infrastructure/staff-guard.ts).
--
-- Single writers:
--   staff, offices, office_staff, settings  -> seed here; settings page (P4)
--   candidates, interviews                  -> lib/onboarding/application/*
--   scorecards                              -> submit-scorecard sentence
--   upload_tokens                           -> outcome sentence (hire) / P2 re-upload
--   outbound_emails                         -> lib/onboarding/infrastructure/outbox.ts
--   events                                  -> append-only side-effect log (any sentence)
create schema if not exists onboarding;

-- Staff who may use /service/onboarding/*: interviewers and approvers.
-- Login match: employee_id -> public.employees.auth_user_id, or email.
-- email is the WORK address used for interview notifications.
create table onboarding.staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  employee_id uuid references public.employees(id),
  active boolean not null default true,
  can_interview boolean not null default true,
  can_approve boolean not null default true,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index staff_email_uq on onboarding.staff (lower(email)) where email is not null;

create table onboarding.offices (
  code text primary key check (code in ('BWK','CAM','RH','SAV')),
  name text not null,
  address text,
  -- Learned from Calendly (setup route / first booking). An office can have
  -- more than one event type (BWK: legacy one-on-one + live collective).
  calendly_event_type_uris text[] not null default '{}',
  calendly_scheduling_url text,
  -- lowercase keywords matched against the Calendly event type name
  calendly_name_keywords text[] not null default '{}',
  gusto_work_location_id text,
  gusto_department text not null,
  samsara_cost_center text not null
);

-- Office -> staff mapping. form_default: preselected interviewer when the
-- Calendly host is a shared mailbox. notify: gets the 15-minute email.
create table onboarding.office_staff (
  office_code text not null references onboarding.offices(code),
  staff_id uuid not null references onboarding.staff(id),
  form_default boolean not null default false,
  notify boolean not null default true,
  primary key (office_code, staff_id)
);
create unique index office_staff_one_default on onboarding.office_staff (office_code) where form_default;

create table onboarding.candidates (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text,
  office_code text references onboarding.offices(code),
  position text not null default 'Maintenance Tech Trainee',
  status text not null default 'scheduled' check (status in (
    'scheduled','no_show','canceled','interviewed','not_hired','follow_up',
    'docs_requested','docs_submitted','reupload_requested','rejected','approved',
    'gusto_invited','onboarding_complete','samsara_added','withdrawn')),
  status_changed_at timestamptz not null default now(),
  overall_score numeric(2,1),
  grade text check (grade in ('A','B','C','D','F')),
  recommendation text check (recommendation in ('hire','no_hire','follow_up')),
  pay_rate numeric(5,2),
  summary_notes text,
  drive_folder_id text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Dedupe by email: one candidate per address, ever.
create unique index candidates_email_uq on onboarding.candidates (lower(email));

create table onboarding.interviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references onboarding.candidates(id),
  office_code text references onboarding.offices(code),
  calendly_event_uri text,
  invitee_uri text,
  event_type_uri text,
  event_name text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  host_email text,
  interviewer_staff_id uuid references onboarding.staff(id),
  status text not null default 'scheduled' check (status in
    ('scheduled','canceled','rescheduled','completed','no_show')),
  reschedule_count int not null default 0,
  pre_email_sent_at timestamptz,
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Webhook retries: one interview row per Calendly invitee.
create unique index interviews_invitee_uq on onboarding.interviews (invitee_uri) where invitee_uri is not null;
create index interviews_start_idx on onboarding.interviews (start_at) where status = 'scheduled';
create index interviews_candidate_idx on onboarding.interviews (candidate_id);

create table onboarding.scorecards (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references onboarding.interviews(id),
  candidate_id uuid not null references onboarding.candidates(id),
  interviewer_staff_id uuid references onboarding.staff(id),
  submitted_by text not null,
  office_code text not null references onboarding.offices(code),
  position text not null,
  interview_type text not null check (interview_type in ('in_person','phone')),
  r_professionalism smallint not null check (r_professionalism between 1 and 5),
  r_presentation smallint not null check (r_presentation between 1 and 5),
  r_communication smallint not null check (r_communication between 1 and 5),
  r_interest smallint not null check (r_interest between 1 and 5),
  r_experience smallint not null check (r_experience between 1 and 5),
  r_essential_functions smallint not null check (r_essential_functions between 1 and 5),
  has_license boolean not null,
  license_state text,
  reliable_transport boolean not null,
  earliest_start date,
  availability text,
  pay_expectation text,
  heard_about text,
  previously_employed boolean not null default false,
  red_flags text,
  comments text,
  overall_score numeric(2,1) not null,
  grade text not null check (grade in ('A','B','C','D','F')),
  recommendation text not null check (recommendation in ('hire','no_hire','follow_up')),
  pay_rate numeric(5,2) check (pay_rate in (14,15,16)),
  pdf_drive_file_id text,
  created_at timestamptz not null default now(),
  -- Comments required when any rating is 2 or lower.
  constraint scorecard_low_rating_needs_comment check (
    least(r_professionalism, r_presentation, r_communication, r_interest,
          r_experience, r_essential_functions) > 2
    or coalesce(btrim(comments), '') <> ''),
  constraint scorecard_hire_needs_rate check (recommendation <> 'hire' or pay_rate is not null)
);
-- Double-click / retry: one scorecard per interview.
create unique index scorecards_interview_uq on onboarding.scorecards (interview_id);

-- Candidate upload links (page ships in P2). Only the SHA-256 of the token
-- is stored; the raw token exists only in the emailed link.
create table onboarding.upload_tokens (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references onboarding.candidates(id),
  token_hash text not null unique,
  purpose text not null default 'initial' check (purpose in ('initial','reupload')),
  requested_docs text[] not null default '{}',
  note text,
  expires_at timestamptz not null default now() + interval '14 days',
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table onboarding.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Outbox: every email the context sends. dedupe_key makes enqueue
-- idempotent; require_status cancels a delayed send (No Hire rejection) if
-- the candidate's status moved on before send_after.
create table onboarding.outbound_emails (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references onboarding.candidates(id),
  interview_id uuid references onboarding.interviews(id),
  kind text not null,
  dedupe_key text not null unique,
  to_addrs text[] not null,
  cc_addrs text[] not null default '{}',
  subject text not null,
  body_html text not null,
  send_after timestamptz not null default now(),
  require_status text,
  status text not null default 'queued' check (status in ('queued','sending','sent','canceled','failed')),
  attempts int not null default 0,
  last_error text,
  gmail_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index outbound_due_idx on onboarding.outbound_emails (send_after) where status = 'queued';

-- Append-only side-effect log (timeline source). Never holds document
-- images, DOB or DL numbers.
create table onboarding.events (
  id bigint generated always as identity primary key,
  candidate_id uuid references onboarding.candidates(id),
  type text not null,
  status text not null default 'ok' check (status in ('ok','error','skipped')),
  payload jsonb not null default '{}',
  error text,
  actor text,
  created_at timestamptz not null default now()
);
create index events_candidate_idx on onboarding.events (candidate_id, created_at);

-- RLS on every table, no policies: service_role only.
alter table onboarding.staff enable row level security;
alter table onboarding.offices enable row level security;
alter table onboarding.office_staff enable row level security;
alter table onboarding.candidates enable row level security;
alter table onboarding.interviews enable row level security;
alter table onboarding.scorecards enable row level security;
alter table onboarding.upload_tokens enable row level security;
alter table onboarding.settings enable row level security;
alter table onboarding.outbound_emails enable row level security;
alter table onboarding.events enable row level security;

-- ---------------------------------------------------------------- seed
insert into onboarding.offices (code, name, address, calendly_name_keywords, gusto_department, samsara_cost_center) values
  ('BWK','Brunswick',null,                                  '{brunswick}',              'BWK Maintenance','BWK - MNT'),
  ('CAM','St. Marys','546 Charlie Smith Sr Hwy, St. Marys, GA','{st marys,st. marys,saint marys}','CAM Maintenance','CAM - MNT'),
  ('RH', 'Richmond Hill','8989 Ford Ave, Richmond Hill, GA',  '{richmond hill}',          'RH Maintenance', 'RH - MNT'),
  ('SAV','Garden City / Savannah','605 US-80, Garden City, GA','{savannah,garden city}', 'SAV Maintenance','SAV - MNT');

-- Back Office (minus Anna Osorio, Vincent Escobar) + Ryan Doyle. Work
-- emails only where known; the rest are filled on the settings page.
insert into onboarding.staff (name, email, employee_id, is_admin)
select s.name, s.email,
       (select e.id from public.employees e
         where e.first_name = s.first and e.last_name = s.last and e.status = 'active' limit 1),
       s.is_admin
from (values
  ('Ryan Doyle',      'ryan@jeffspoolspa.com',   'Ryan',        'Doyle',    true),
  ('Carter Gasia',    'carter@jeffspoolspa.com', 'Carter',      'Gasia',    true),
  ('Chris Stephens',  'chris@jeffspoolspa.com',  'Christopher', 'Stephens', false),
  ('Donivan Sphar',   'jpsretail@jeffspoolspa.com','Donivan',   'Sphar',    false),
  ('Jackie Amburgey', null,                      'Jacquelyn',   'Amburgey', false),
  ('Erin Cowan',      null,                      'Erin',        'Cowan',    false),
  ('Mary Kidd',       null,                      'MaryMarie',   'Kidd',     false),
  ('Zachary Taylor',  null,                      'Zachary',     'Taylor',   false)
) as s(name, email, first, last, is_admin);

insert into onboarding.office_staff (office_code, staff_id, form_default, notify)
select m.office, st.id, m.dflt, true
from (values
  ('BWK','Mary Kidd',true), ('SAV','Chris Stephens',true),
  ('RH','Jackie Amburgey',true), ('RH','Erin Cowan',false),
  ('CAM','Donivan Sphar',true)
) as m(office, staff_name, dflt)
join onboarding.staff st on st.name = m.staff_name;

insert into onboarding.settings (key, value) values
  -- false = safe mode: every recipient outside @jeffspoolspa.com is
  -- rewritten to test_recipient. Flip only after Ryan's go-ahead.
  ('live_mode', 'false'),
  ('test_recipient', '"ryan@jeffspoolspa.com"'),
  ('test_candidate_emails', '["ryan.m.doyle@gmail.com","ryan@jeffspoolspa.com"]'),
  ('shared_mailboxes', '["jpsbilling@jeffspoolspa.com","jpsretail@jeffspoolspa.com"]'),
  ('sender', '"jpsbilling@jeffspoolspa.com"'),
  ('app_base_url', '"https://internal.jeffspoolspa.com"'),
  ('rejection_delay_hours', '24'),
  ('email_templates', jsonb_build_object(
    'rejection', jsonb_build_object(
      'subject', 'Your application with Jeff''s Pool & Spa',
      'body', '<p>Hi {{first_name}},</p><p>Thank you for taking the time to interview with Jeff''s Pool &amp; Spa. We appreciate your interest in the position.</p><p>After careful consideration, we have decided not to move forward with your application at this time. We will keep your information on file and encourage you to apply again in the future.</p><p>We wish you the best in your search.</p><p>Jeff''s Pool &amp; Spa</p>'),
    'follow_up', jsonb_build_object(
      'subject', 'Next step: a follow-up interview with Jeff''s Pool & Spa',
      'body', '<p>Hi {{first_name}},</p><p>Thanks for meeting with us. We would like to schedule a follow-up interview with our {{office_name}} office.</p><p>Please pick a time that works for you here: <a href="{{scheduling_url}}">{{scheduling_url}}</a></p><p>Jeff''s Pool &amp; Spa</p>'),
    'hire', jsonb_build_object(
      'subject', 'Congratulations from Jeff''s Pool & Spa – next steps',
      'body', '<p>Hi {{first_name}},</p><p>Congratulations! You are being considered for hire into our maintenance training program at our {{office_name}} office.</p><p>The training wage is <strong>${{pay_rate}}/hr</strong>. You will receive a <strong>$1/hr raise when you pass training</strong>, and <strong>another $1/hr when you are covering your own route</strong>.</p><p><strong>Final step:</strong> upload your hiring documents (Georgia driving record, driver''s license and criminal history report) on your personal upload page:</p><p><a href="{{upload_url}}">{{upload_url}}</a></p><p>The link is unique to you and expires in 14 days.</p><p>Jeff''s Pool &amp; Spa</p>')
  ));

-- ---------------------------------------------------------- scheduler
-- pg_cron -> pg_net -> the app's machine door /api/onboarding/tick, same
-- vault-secret pattern as billing (url secret + shared machine token).
create or replace function onboarding.wake_tick()
returns void
language plpgsql security definer
set search_path to 'onboarding', 'public'
as $$
declare
  v_url text;
  v_token text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'onboarding_tick_url' limit 1;
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'billing_tick_token' limit 1;
  if v_url is null or v_token is null then return; end if;
  perform net.http_post(
    url := v_url,
    body := '{"source":"pg_cron"}'::jsonb,
    headers := jsonb_build_object('x-drain-token', v_token, 'Content-Type', 'application/json'),
    timeout_milliseconds := 5000
  );
exception when others then
  return; -- best-effort; the next tick comes in 5 minutes
end;
$$;
revoke all on function onboarding.wake_tick() from public, anon, authenticated;

select cron.schedule('onboarding-tick', '*/5 * * * *', 'select onboarding.wake_tick()');

-- PostgREST exposure: service_role only (backend schema)
grant usage on schema onboarding to service_role;
grant all on all tables in schema onboarding to service_role;
grant usage, select on all sequences in schema onboarding to service_role;
alter default privileges in schema onboarding grant all on tables to service_role;
alter default privileges in schema onboarding grant usage, select on sequences to service_role;
alter role authenticator set pgrst.db_schemas to 'public,graphql_public,app_checks,maintenance,billing_audit,billing,agreements,routing,support,onboarding';
notify pgrst, 'reload config';
