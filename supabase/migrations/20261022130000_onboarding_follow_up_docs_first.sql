-- Module: lib/onboarding. Approval is two steps: approve the documents
-- (checklist) -> Docs Approved, then approve the hire (start date, pay rate,
-- Marsh draft) -> Approved. A Follow-up recommendation requests documents
-- first (same upload link as Hire, its own wording); approving them sends the
-- follow-up booking link; the booked interview is Second Interview; an
-- approver then decides Hire (-> Docs Approved, only the hire step left) or
-- No Hire, each with a reason.
--   candidates.status: + docs_approved, second_interview
--   approvals.decision: + docs_approve (the checklist, both paths),
--     hire / no_hire (after the second interview; reason required);
--     approve is now the hire step (start date + pay rate, no checklist)
--   settings.email_templates.follow_up_docs, settings.sms_templates.follow_up_docs
alter table onboarding.candidates drop constraint if exists candidates_status_check;
alter table onboarding.candidates add constraint candidates_status_check check (status in (
  'scheduled','no_show','canceled','interviewed','not_hired','follow_up','second_interview',
  'docs_requested','docs_submitted','reupload_requested','docs_approved','rejected','approved',
  'gusto_invited','onboarding_complete','samsara_added','withdrawn'));
alter table onboarding.approvals drop constraint if exists approvals_decision_check;
alter table onboarding.approvals add constraint approvals_decision_check check (decision in ('approve','reject','reupload','docs_approve','hire','no_hire'));
alter table onboarding.approvals add constraint second_interview_decision_needs_reason check (decision not in ('hire','no_hire') or coalesce(btrim(notes),'') <> '');
update onboarding.settings
set value = value || jsonb_build_object('follow_up_docs', jsonb_build_object(
  'subject', 'Next step with Jeff''s Pool & Spa – your documents',
  'body', '<p>Hi {{first_name}},</p><p>Thanks for meeting with us. Before we schedule a follow-up interview with our {{office_name}} office, please upload your hiring documents (Georgia driving record, driver''s license and criminal history report) on your personal upload page:</p><p><a href="{{upload_url}}">{{upload_url}}</a></p><p>The link is unique to you and expires in 14 days. Once we have reviewed them, we will send you a link to book the follow-up interview.</p><p>Jeff''s Pool &amp; Spa</p>'))
where key = 'email_templates' and not value ? 'follow_up_docs';
update onboarding.settings
set value = value || jsonb_build_object('follow_up_docs',
  'Jeff''s Pool & Spa: Thanks {{first_name}}! Before your follow-up interview, upload your GA driving record, driver''s license photos and criminal history report here: {{upload_url}} (link expires in 14 days). Reply STOP to opt out.')
where key = 'sms_templates' and not value ? 'follow_up_docs';
