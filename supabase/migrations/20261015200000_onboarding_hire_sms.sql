-- Applied via MCP 2026-10-15 as onboarding_hire_sms.
-- Module: lib/onboarding (writer of outbound_emails: infrastructure/outbox.ts)
-- Hired candidates also get a text with their upload link (RingCentral).
--   outbound_emails.channel: the outbox now carries texts too ('sms': to_addrs
--     holds phone numbers, subject is unused).
--   offices.sms_sender: which RingCentral office number texts for this
--     branch (lib/comms/office-config RC_OFFICE_CONFIG keys). SAV has no
--     RingCentral number of its own; it uses Brunswick's until one exists.
--   settings.test_phone: where texts go while live_mode is off or for test
--     candidates. settings.sms_templates.hire: the text body.
alter table onboarding.outbound_emails add column if not exists channel text not null default 'email' check (channel in ('email','sms'));
alter table onboarding.offices add column if not exists sms_sender text check (sms_sender in ('richmond_hill','brunswick','st_marys'));
update onboarding.offices set sms_sender = case code when 'RH' then 'richmond_hill' when 'CAM' then 'st_marys' else 'brunswick' end where sms_sender is null;
insert into onboarding.settings (key, value) values
  ('test_phone', '"8452700395"'),
  ('sms_templates', jsonb_build_object('hire',
    'Jeff''s Pool & Spa: Congrats {{first_name}}! Last step for our maintenance training program: upload your GA driving record, driver''s license photos and criminal history report from your phone here: {{upload_url}} (link expires in 14 days). Reply STOP to opt out.'))
on conflict (key) do nothing;
