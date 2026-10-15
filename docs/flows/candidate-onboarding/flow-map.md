# Candidate onboarding: flow map

> Status: [active] P1 sequence.
> Last updated: 2026-10-15

1. Candidate books "Interview - <office>" in Calendly.
2. Calendly -> `POST /api/webhooks/calendly` [trigger] -> verify signature -> `ingestBooking`:
   upsert candidate (email), create or move the interview, log events. If the start is
   < 15 min away, queue + send the heads-up now.
3. pg_cron every 5 min -> `onboarding.wake_tick()` -> `POST /api/onboarding/tick` -> `runTick`:
   queue due heads-ups and reminders, retry scorecard PDFs, drain the outbox.
4. Interviewer opens the link -> `/service/onboarding/interview?i=<id>` (staff allowlist).
   - No Show button -> `markNoShow` (status only).
   - Submit -> `submitScorecard`: save (one per interview) -> candidate fields + score ->
     status Interviewed -> outcome status -> queue the outcome email -> send immediate
     ones -> render PDF -> Drive `JPS Hiring/Last, First/Last, First - Interview Scorecard - YYYY-MM-DD.pdf`.
5. Delayed rejection goes out on a later tick, unless the status moved.

Setup (once, re-runnable): an onboarding admin uses `/service/onboarding/setup` (Connect
Calendly; or `POST /api/onboarding/calendly/setup`)
to map event types to offices, store each office's scheduling link, and create the
org webhook subscription.
