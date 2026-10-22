# Candidate onboarding: schema contract

> Status: [active] P1 + P2 tables. Migrations: `20261015190000_onboarding_context_floor.sql`, `20261015193000_onboarding_outbox_claimed_at.sql`, `20261015203000_onboarding_p2_documents_approvals.sql`, `20261022120000_onboarding_staff_upload.sql`, `20261022130000_onboarding_follow_up_docs_first.sql`.
> Last updated: 2026-10-22

| Table | Purpose | Writer | Key / idempotency |
|---|---|---|---|
| `onboarding.staff` | Interviewers/approvers allowlist; `email` = work address for notifications; `employee_id` links `public.employees` (login match via `auth_user_id`) | seed; settings page (P4) | unique lower(email) |
| `onboarding.offices` | BWK/CAM/RH/SAV: Calendly event type URIs + scheduling link, Gusto department, Samsara cost center | seed; `calendly-setup`; `ingest-booking` (learns event type URIs) | code |
| `onboarding.office_staff` | Office -> staff: `form_default` (interviewer when the Calendly host is a shared mailbox), `notify` (gets the 15-min email) | seed | one default per office |
| `onboarding.candidates` | One per person | `ingest-booking`, `submit-scorecard` | unique lower(email) |
| `onboarding.interviews` | One per Calendly invitee; a reschedule moves the row | `ingest-booking`, `submit-scorecard`, `markNoShow`, outbox (sent stamps) | unique invitee_uri |
| `onboarding.scorecards` | One per interview | `submit-scorecard`; tick (pdf id retry) | unique interview_id |
| `onboarding.upload_tokens` | Candidate upload links (sha256 only, 14 days) | `submit-scorecard` (hire); P2 re-upload | unique token_hash |
| `onboarding.candidate_details` | Legal name, DOB, GA DL#, expiry, licensed 3+ years; `entered_by_staff_id` null = the candidate typed them | `submit-documents` (initial link), `staff-documents` | candidate_id |
| `onboarding.documents` | One row per filed PDF; `source` upload/staff/scorecard/seed (`uploaded_by_staff_id` when staff); `review_status` pending/accepted/reupload_requested/superseded (one live copy per required type) | `submit-documents` (`fileDocuments`), `staff-documents`, `fileScorecardPdf`, `review` | unique drive_file_id |
| `onboarding.approvals` | Approve / reject / re-upload decisions | `review` | id |
| `onboarding.settings` | live_mode, test recipient, templates, rejection delay | seed; settings page (P4) | key |
| `onboarding.outbound_emails` | Outbox for every email and text (`channel` email/sms) | `infrastructure/outbox.ts` only | unique dedupe_key |
| `onboarding.events` | Append-only side-effect log / timeline | any sentence via `logEvent` | identity |

## External calls

| System | Call | From |
|---|---|---|
| Calendly | webhook in (invitee.created / invitee.canceled) | `/api/webhooks/calendly` |
| Calendly | `GET /users/me`, `GET /event_types`, `GET/POST /webhook_subscriptions` | `calendly-setup` |
| Gmail (as jpsbilling@) | `users.messages.send` | outbox drain |
| RingCentral | `POST /extension/{id}/sms` from the office number (`lib/external/ringcentral/sms.ts`; does not write the customer comms tables) | outbox drain |
| Drive (as jpsbilling@) | find/create `Last, First` folder under JPS Hiring, multipart upload | scorecard PDF, candidate and staff document filing |

## Env

`GOOGLE_SERVICE_ACCOUNT_JSON`, `CALENDLY_PAT`, `CALENDLY_WEBHOOK_SIGNING_KEY`; machine door
reuses `INVOICE_DRAIN_TOKEN || WINDMILL_TOKEN` (same as `/api/billing/tick`).
