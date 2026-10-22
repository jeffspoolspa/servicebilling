-- Module: lib/onboarding. Staff edit a candidate's typed fields on the
-- candidate page (application/edit-candidate.ts) with a version check:
-- the form carries the row's updated_at and the save only matches that value.
--   candidates.previous_emails: addresses the candidate had before an edit;
--     a Calendly booking under one still finds the candidate (ingest-booking).
--   touch_updated_at: every update stamps updated_at, so the version moves
--     whichever code writes the row.
alter table onboarding.candidates add column if not exists previous_emails text[] not null default '{}';

create or replace function onboarding.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists candidates_touch_updated_at on onboarding.candidates;
create trigger candidates_touch_updated_at before update on onboarding.candidates
  for each row execute function onboarding.touch_updated_at();
drop trigger if exists candidate_details_touch_updated_at on onboarding.candidate_details;
create trigger candidate_details_touch_updated_at before update on onboarding.candidate_details
  for each row execute function onboarding.touch_updated_at();
