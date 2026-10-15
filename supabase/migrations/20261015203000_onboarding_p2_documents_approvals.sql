-- Applied via MCP 2026-10-15 in three parts: onboarding_p2_tables, onboarding_p2_settings,
-- onboarding_p2_upload_bucket (the reupload email template is its own settings key).
-- Module: lib/onboarding. P2: candidate upload -> Drive -> review email -> approval.
-- Writers:
--   candidate_details, documents (source upload) -> application/submit-documents.ts
--   documents (source scorecard)                 -> fileScorecardPdf
--   approvals, candidates.gusto_* / marsh_draft_id / target_start_date -> application/review.ts
-- candidate_details holds DOB and DL number: never logged, never emailed
-- except the Marsh driver-add draft.
-- Storage bucket onboarding-uploads (private): staging for browser uploads
-- (signed upload URLs; Vercel functions cap request bodies at 4.5 MB). Files
-- are moved to Drive on submit and deleted from the bucket.
create table onboarding.candidate_details (
  candidate_id uuid primary key references onboarding.candidates(id),
  legal_first text not null,
  legal_last text not null,
  dob date not null,
  dl_number text not null,
  dl_state text not null default 'GA' check (dl_state = 'GA'),
  dl_expires date not null,
  first_licensed_year int not null check (first_licensed_year between 1940 and 2100),
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table onboarding.documents (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references onboarding.candidates(id),
  doc_type text not null check (doc_type in ('MVR','Drivers License','Criminal History','Interview Scorecard','Application','Other')),
  drive_file_id text not null,
  filename text not null,
  mime_type text not null default 'application/pdf',
  size_bytes bigint,
  source text not null default 'upload' check (source in ('upload','scorecard','seed')),
  upload_token_id uuid references onboarding.upload_tokens(id),
  review_status text not null default 'pending' check (review_status in ('pending','accepted','reupload_requested','superseded')),
  uploaded_at timestamptz not null default now()
);
create unique index documents_drive_file_uq on onboarding.documents (drive_file_id);
create index documents_candidate_idx on onboarding.documents (candidate_id, doc_type);
create table onboarding.approvals (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references onboarding.candidates(id),
  approver_staff_id uuid references onboarding.staff(id),
  approver text not null,
  decision text not null check (decision in ('approve','reject','reupload')),
  checklist jsonb not null default '{}',
  notes text,
  target_start_date date,
  pay_rate numeric(5,2),
  created_at timestamptz not null default now(),
  constraint approve_needs_start check (decision <> 'approve' or target_start_date is not null),
  constraint reject_needs_reason check (decision <> 'reject' or coalesce(btrim(notes),'') <> '')
);
create index approvals_candidate_idx on onboarding.approvals (candidate_id, created_at);
alter table onboarding.outbound_emails add column if not exists attachments jsonb not null default '[]';
alter table onboarding.candidates add column if not exists gusto_invited_at timestamptz;
alter table onboarding.candidates add column if not exists gusto_invited_by text;
alter table onboarding.candidates add column if not exists marsh_draft_id text;
alter table onboarding.candidates add column if not exists target_start_date date;
alter table onboarding.candidate_details enable row level security;
alter table onboarding.documents enable row level security;
alter table onboarding.approvals enable row level security;
grant all on onboarding.candidate_details, onboarding.documents, onboarding.approvals to service_role;
insert into onboarding.settings (key, value) values
  ('review_recipients', '["jpsbilling@jeffspoolspa.com","carter@jeffspoolspa.com","chris@jeffspoolspa.com"]'),
  ('marsh', '{"to":["Andrew.Dowell@marshmma.com","Alicia.Pasupuletti@marshmma.com"],"cc":["ryan@jeffspoolspa.com","carter@jeffspoolspa.com","chris@jeffspoolspa.com"]}'),
  ('approval_checklist', '[
    {"key":"license_valid","label":"Georgia license: valid, not expired, name matches"},
    {"key":"age_21","label":"Age 21 or older (from DOB)"},
    {"key":"mvr_valid","label":"MVR covers 3 years, is dated within the last 30 days, and its name and DL# match"},
    {"key":"licensed_3y","label":"Licensed 3+ years"},
    {"key":"driving_criteria","label":"None of the unacceptable driver criteria below (no Type A violation, fewer than 3 Type B in 3 years, no GA super speeder)"},
    {"key":"criminal_reviewed","label":"Criminal history report present and reviewed under company criteria"}
  ]'),
  ('sms_reupload', '"Jeff''s Pool & Spa: Hi {{first_name}}, we need a new copy of some hiring documents. Details and your upload link: {{upload_url}} Reply STOP to opt out."'),
  ('reupload_email', jsonb_build_object('subject','Jeff''s Pool & Spa: please re-upload a document',
    'body','<p>Hi {{first_name}},</p><p>Thanks for sending your documents. We need a new copy of: <strong>{{documents}}</strong>.</p><p>{{note}}</p><p>Please upload it here: <a href="{{upload_url}}">{{upload_url}}</a> (the link expires in 14 days).</p><p>Jeff''s Pool &amp; Spa</p>'))
on conflict (key) do nothing;
insert into storage.buckets (id, name, public, file_size_limit)
values ('onboarding-uploads', 'onboarding-uploads', false, 26214400)
on conflict (id) do nothing;
