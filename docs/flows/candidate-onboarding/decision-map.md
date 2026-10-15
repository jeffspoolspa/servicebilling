# Candidate onboarding: decision map

> Status: [active] P1 rules.
> Last updated: 2026-10-15

## Booking

| Situation | Rule |
|---|---|
| Office | Event type URI if known, else the office code or keyword in the event name (`brunswick`, `richmond hill`, `savannah`/`garden city`, `st marys`). Unmapped -> logged as an error; the form lets staff pick. |
| Interviewer | First Calendly host that is not a shared mailbox (jpsbilling@, jpsretail@), matched to staff by email; otherwise the office's `form_default` (BWK Mary Kidd, SAV Chris Stephens, RH Jackie Amburgey, CAM Donivan Sphar). |
| Candidate | Deduped by email. A new booking sets status Scheduled unless the candidate is already in the documents stage or later. |
| Phone | The required phone question (any question containing phone/mobile/cell), else Calendly's text-reminder number. |
| Reschedule | The created half moves the existing interview (new time, reminders reset). The canceled half marks it `rescheduled` only if it still points at the old invitee. |
| Cancel | Interview Canceled; candidate Canceled if no other open interview and status was Scheduled. No emails. |

## Emails

| Email | When | To | Guard |
|---|---|---|---|
| Interview in 15 min | start - 15 min (tick), or at booking if booked < 15 min out | personal host, else office `notify` staff (RH: Jackie + Erin), else jpsbilling@ | interview still scheduled at the queued time |
| Scorecard reminder | end + 2 h, once, no scorecard | interviewer, cc jpsbilling@ | interview still scheduled |
| Rejection (No Hire) | decision + `rejection_delay_hours` (24) | candidate | candidate status still Not Hired |
| Follow-up | immediately | candidate | needs the office's Calendly scheduling link (from setup) |
| Hire | immediately | candidate | new 14-day upload token |
| Hire text | immediately, with the hire email | candidate's phone, from the office RingCentral number (`offices.sms_sender`; SAV uses Brunswick's) | same upload link; live_mode off or test candidate -> `settings.test_phone` |
| Office notice | booking, reschedule, cancel, scorecard, No Show, approve, reject, re-upload, Gusto invite (`office-notice.ts`) | `settings.sender` (jpsbilling@) | one-line update + link to the candidate page; queued, sent by the step's drain or the next tick |
| Candidate branding | every candidate-facing email/text and the upload page | — | office brand from `settings.office_brands` (RH = Perfect Pools, Reply-To info@perfectpoolscleaning.com) |

## Scorecard

| Rule | Value |
|---|---|
| Overall | mean of 6 ratings (1-5), 1 decimal |
| Grade | A >= 4.5, B >= 3.75, C >= 3.0, D >= 2.25, F below |
| Comments | required if any rating <= 2 (also a DB check) |
| Hire | pay rate $14/$15/$16, default $14 |
| Email + phone | required |
| No Show | status only; blocked once a scorecard exists |
| Outcome status | Hire -> Docs Requested; No Hire -> Not Hired; Follow-up -> Follow-up Interview |
