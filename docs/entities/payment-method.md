# Entity: Payment Method

> Lives in: cached QBO payment methods per customer (card/ACH on file)
> Source: [cache: QBO]
> Status: [stub]

## What it is

A customer's card or bank account on file, cached from QBO so [process_work_order](../scripts/service_billing/process_work_order.md) can charge without a live QBO round-trip at charge time. The `payment_method_ok` indicator on [Invoice](invoice.md) is true when a billable PM is resolved here.

> This is a stub. Fill in: the exact table/columns, the freshness gate (`Customers.pm_last_checked_at`), and the atomic-claim dedup added after the [pull_customer_payment_methods loop postmortem](../audits/2026-05-27-database.md). The loop happened because a PM-refresh request trigger fired per-row on every 4h invoice refresh — the fix was a 60s atomic-claim guard so each customer is refreshed at most once per minute.

## How a card gets ON file (the card-vault service)

Card capture runs through the **card-vault** service — a separate Supabase project
(`rjxhummrmyigngdqiuic`, "card-vault") plus the SPA at `secure.jeffspoolspa.com`. Raw card
data never touches this app or its database.

1. The app mints a single-use capture session server-to-server:
   `POST {CARD_VAULT_FUNCTIONS_URL}/functions/v1/mint-session` with
   `Authorization: Bearer {CARD_VAULT_SECRET_KEY}` and
   `{customer_id, qbo_customer_id, customer_name, kind: "internal" | "link"}` →
   `{capture_session, expires_at}` (internal TTL 10 min, link TTL 48 h).
2. The app embeds `{NEXT_PUBLIC_CARD_VAULT_URL}/capture?session=...&origin=<app origin>`.
   The iframe posts origin-targeted messages to the parent: `ready`, `resize {height}`,
   `card_processing`, `card_saved {method_type, payment_method_id, last4, brand}`,
   `card_error {code, message}`.
   **Always pass an explicit `&theme=light|dark`.** With no theme the capture page follows the
   *viewer's* `prefers-color-scheme`, independent of the embedding page — so a dark-mode browser
   renders the light-on-dark palette onto a white panel and the entire form goes invisible
   (white on white, no error, no console message). This bit the internal add-card panel.
3. The vault's `capture` edge function claims the session (single-use, atomic), posts the
   card/bank account to QBO Payments (`POST /quickbooks/v4/customers/{id}/cards` or
   `/bank-accounts`), validates cards with a $1 uncaptured auth, and keeps an AES-GCM
   encrypted copy in its own `card_vault` table.
4. Back in this app, the internal add-card form
   (`app/(shell)/customers/[id]/payment-methods/AddCardPanel.tsx`) then runs
   `pull_customer_payment_methods` (only_customer_id) so this cache converges immediately.

### Blockers before this can run against real cards

- ~~Two QBO refreshers exist.~~ **Fixed 2026-08-04.** `f/qbo/get_access_token` (the vault's
  provider) used to refresh and rotate `u/carter/quickbooks_api` itself with no concurrency
  limit, making it a second independent refresher of a rotating token — the burned-integration
  failure ADR 012 exists to prevent. It is now a **cache in front of the one door**: it serves a
  cached access token and, on a miss, delegates the refresh to `f/qbo/api/get_access_token`
  (`concurrent_limit: 1`), which owns the rotation and the rotated-token save. The cache is what
  stops a burst of captures from triggering a rotation each; the one door is what guarantees the
  rotation is serialized. Verified: two back-to-back calls, one rotation.
- **The vault may still be pointed at the QBO sandbox.** `_shared/qbo.ts` reads `QBO_BASE_URL`
  and defaults to `https://sandbox.api.intuit.com`. Confirm the edge secret is set to
  `https://api.intuit.com` in the card-vault project before collecting a real card.
- **Never exercised.** `capture_sessions` and `card_vault` are both empty (0 rows as of
  2026-08-04) — no card has ever gone through this service.

`[drift]` The older token flow (`card_collection_requests` + `/collect?token=...`, see
[Card Collection Request](card-collection-request.md)) predates the vault rebuild: the
deployed SPA only serves `/capture?session=...`, so the lead-onboarding embed and the
website get-started page still pointing at `/collect` need re-wiring to capture sessions.
Note `/collect` is being reclaimed by the new customer self-service form
([card-on-file-collection](../flows/card-on-file-collection/index.md)) — which takes no token,
so those old `?token=` links will land on the address search rather than erroring.

## A card we cannot charge is not active

QBO reports a card as `status: ACTIVE` **forever** — it never retires expired cards — and
`fetch()` filters on exactly that flag. So expiry, and duplicate entries for the same physical
card, both used to sit in the wallet looking chargeable.

Rather than add a parallel "expired" concept every caller must remember, this folds into
`is_active`, which the whole billing path already reads (`fn_maintain_default_pm`,
`pick_target_payment_method`, `fn_set_payment_method_ok_from_cpm`). `fn_user_deactivation_wins`
— which already forced `is_active = false` for a human's decision — now also forces it when:

- **the card is past `expires_on`** (`billing.pm_expires_on(raw)`, the last day of its expiry
  month, exposed as a generated column); or
- **a newer entry exists for the same physical card**, keyed on QBO's own `numberSHA512` hash,
  so a renewal supersedes its predecessor without this database ever seeing a PAN.

`pick_target_payment_method` re-checks expiry directly as well. That is deliberate belt-and-
braces: the trigger only re-evaluates when a row is written, so a card that expires between
refreshes is briefly stale in the table, and the charge path must never hand QBO a dead card
even for that window.

**What this found (2026-08-04, migration `20260804210000`):** of 1,029 cards on file, 63 were
expired, 60 of those still counted as usable, and **17 customers' default payment method was an
expired card** — all queued to decline. Duplicates were the rare case: exactly one pair in 1,029,
and it was a renewal (same Discover ···2530, new expiry), not a double-submit.

A follow-up (`20260804210500`) found the "one usable default per customer" invariant had also
drifted: 22 customers with multiple defaults, and **6 with a good card but no default at all** —
which `pick_target_payment_method` requires, so those six were silently falling through to email.

**Still not prevented:** the vault can still create a duplicate *in QBO*. QBO permits it and we
cannot stop it from our side; deduping at the point of use is what protects billing.

## Connected entities

- [Customer](customer.md) via `qbo_customer_id`
- [Invoice](invoice.md) — resolves the `payment_method_ok` indicator via [set_payment_method_ok](../scripts/_triggers/set_payment_method_ok.md)

## Flows this entity participates in

- [qbo-payment-methods sync](../flows/sync/qbo-payment-methods.md) — keeps PMs current
