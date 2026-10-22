-- Module: lib/onboarding. Staff file documents and license details on the
-- candidate page (application/staff-documents.ts).
--   documents.source 'staff' + uploaded_by_staff_id: who filed it. Staged in
--     the same onboarding-uploads bucket under staff/<candidate id>/.
--   candidate_details.entered_by_staff_id: null = the candidate typed them.
alter table onboarding.documents drop constraint if exists documents_source_check;
alter table onboarding.documents add constraint documents_source_check check (source in ('upload','scorecard','seed','staff'));
alter table onboarding.documents add column if not exists uploaded_by_staff_id uuid references onboarding.staff(id);
alter table onboarding.documents add constraint documents_staff_source_has_staff check (source <> 'staff' or uploaded_by_staff_id is not null);
alter table onboarding.candidate_details add column if not exists entered_by_staff_id uuid references onboarding.staff(id);
