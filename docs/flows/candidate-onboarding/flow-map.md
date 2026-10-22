# Candidate onboarding: flow map

> Status: [active] P1 sequence.
> Last updated: 2026-10-22

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
5. Delayed rejection goes out on a later tick, unless the status moved. Follow-up takes the same
   documents step as Hire (step 6, its own email/text wording); its booking link waits for step 7.
6. Hire -> candidate gets email + text with `/service/onboarding/upload/<token>`: details (legal name,
   DOB, GA DL#, expiry, year first licensed; non-GA blocks), MVR, DL front/back, criminal report.
   Photos are compressed in the browser, staged in storage, converted to one PDF per document and
   filed to Drive as `Last, First - <DocType> - YYYY-MM-DD.pdf`. Status Docs Submitted; review email
   (docs attached, <= 20 MB else MVR + DL only) to `settings.review_recipients`.
7. Approver opens the review page. Two steps:
   - Documents: checklist (all required) -> Approve documents (Docs Approved) / Reject (reason;
     rejection email) / Request re-upload (new link by email + text).
   - Hire (Docs Approved): start date, pay rate -> Approve hire (Marsh driver-add Gmail DRAFT,
     Approved) / Reject.
   - Follow-up path: Approve documents -> Follow-up Interview + booking link -> booked -> Second
     Interview -> after it starts, an approver records Hire or No Hire with a reason
     (`decideSecondInterview`). Hire -> Docs Approved, so only the hire step is left.
   - Staff can edit the candidate (name, email, phone, office, position, notes) with a version
     check: a save made by someone else in between refuses yours (`edit-candidate.ts`).
   - Staff can file documents (MVR, Drivers License, Criminal History, Other) and
     enter or correct license details on the same page (`staff-documents.ts`; staged under
     `staff/<candidate id>/`, filed to Drive the same way, `source = 'staff'`). When that leaves
     Docs Requested / Re-upload Requested with every required document live and details present,
     the candidate moves to Docs Submitted and the open upload link is revoked. No review email.
8. Staff create the employee in Gusto from the panel's values, then Mark invited -> Gusto Invited.

Setup (once, re-runnable): an onboarding admin uses `/service/onboarding/setup` (Connect
Calendly; or `POST /api/onboarding/calendly/setup`)
to map event types to offices, store each office's scheduling link, and create the
org webhook subscription.
