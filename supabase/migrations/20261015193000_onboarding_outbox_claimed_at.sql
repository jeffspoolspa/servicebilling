-- Applied via MCP 2026-10-15 as onboarding_outbox_claimed_at.
-- Module: lib/onboarding (writer: lib/onboarding/infrastructure/outbox.ts)
-- When a drainer claimed a row (status -> sending). A row still 'sending'
-- 15 min after its claim was interrupted mid-send and is marked failed
-- (never auto-retried: a retry could double-send; Resend re-queues it).
alter table onboarding.outbound_emails add column if not exists claimed_at timestamptz;
