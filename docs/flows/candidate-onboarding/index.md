# Candidate onboarding

> Status: [active] Phase P1 (Calendly -> interview -> outcomes). P2-P5 pending.
> Last updated: 2026-10-15

Hiring pipeline for field staff: a candidate books an interview in Calendly, the
interviewer gets a 15-minute heads-up and fills one scorecard, and the recommendation
drives the next email (rejection, follow-up booking link, or the hire email with a
document upload link). Later phases add the upload page, approval, the Marsh driver-add
draft, the Gusto hand-off and the Samsara driver.

## Layer 0: where it sits

| Piece | Where | Notes |
|---|---|---|
| Pages | `app/(onboarding)/service/onboarding/*` | Own route group, NOT behind the Service module guard. Access = `onboarding.staff` allowlist (`lib/onboarding/infrastructure/staff-guard.ts`), on top of the app's existing email/password login (unchanged). |
| Domain | `lib/onboarding/domain` | Scoring, grades, statuses, naming conventions, booking rules. `npx tsx lib/onboarding/domain/selfcheck.ts` |
| Sentences | `lib/onboarding/application` | `ingest-booking`, `submit-scorecard` (+ `markNoShow`), `tick`, `calendly-setup` |
| ACLs | `lib/external/calendly`, `lib/external/google` | Calendly API v2 + webhook verify; Google service account (DWD as jpsbilling@) for Gmail and Drive |
| Data | schema `onboarding` (Supabase `vvprodiuwraceabviyes`) | service_role only, RLS on, no policies. Hiring PII. |
| Scheduler | pg_cron `onboarding-tick` every 5 min -> `onboarding.wake_tick()` -> `POST /api/onboarding/tick` | Vault secrets `onboarding_tick_url` + shared `billing_tick_token` (the machine token) |
| Webhook in | `POST /api/webhooks/calendly` | HMAC signature with `CALENDLY_WEBHOOK_SIGNING_KEY` |

No Zapier, no Windmill. Facts for this context live in `onboarding.events` (side-effect
log with candidate id, status and error), not `maintenance.events`: hiring data stays in
the PII-scoped schema.

## Layers

- [Schema contract](schema-contract.md)
- [Decision map](decision-map.md)
- [Flow map](flow-map.md)

## Safety rails

- `settings.live_mode = false` (default): every email to an address outside
  `@jeffspoolspa.com` is rewritten to `settings.test_recipient` with a TEST banner.
- Test candidates (`is_test`: email in `settings.test_candidate_emails`, or a first/last
  name starting with "Test") email nobody but the test recipient, internal staff included.
- Drive: files go only under the `JPS Hiring` root, one `Last, First` folder per person
  (test candidates: `_TEST Last, First`). Nothing is ever shared.
