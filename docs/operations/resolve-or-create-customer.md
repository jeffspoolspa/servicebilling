# Operation: resolve-or-create customer

> Status: [design] — extracted as a standalone flow 2026-06-10 (structural gap 1 of
> [lead-intake open questions](../flows/lead-intake-to-conversion/open-questions.md));
> code still lives inline in `lib/leads/intake.ts` until the refactor lands.
> Kind: shared operation (verb). First doc in `docs/operations/` — one doc per reusable verb,
> per the nouns/verbs/sentences model in [FLOW_DIAGRAM_NOTATION.md](../conventions/FLOW_DIAGRAM_NOTATION.md).
> Address resolution + the customer↔address ledger this composer writes to:
> [ADR 007](../adrs/007-address-resolution-and-customer-address-ledger.md).

**One-line purpose:** turn contact + address into an `account_id` without creating duplicate
customers — reusable by any flow that needs "a customer must exist before X".

## Contract

| Direction | Shape |
|---|---|
| Context in | `{ contact: {first, last, email?, phone?}, address: {street, city, state, zip}, action: auto \| use_existing \| create_new, existing_customer_id? }` |
| Context out (adds) | `{ account_id, location_id, qbo: created \| deferred \| skipped, returning }` |

## Steps (its own pipeline)

1. **Find matches** `[rpc]` `[shared]` — `search_accounts_by_contact` (query: safe, repeatable;
   also called directly by the internal form's live dedup check). On matches with an
   interactive caller: matches are returned for the caller to decide (command-query separation —
   the human decision happens between the query and the command).
2. **Reuse or create** `[rpc]` — match + `auto`/`use_existing`: `update_customer` (row-locked
   contact refresh); otherwise `create_account`. [attention] gap 5: race guard (re-check inside
   `create_account`, `p_force` to override) not yet implemented.
3. **Primary location** `[table]` — select-or-insert on `service_locations`. [attention] gap 2:
   check-then-act race; to become a guarded RPC. Also resolve the billing-vs-service address
   question recorded in the lead-intake open questions.
4. **QBO create** `[wm]` `[shared]` — `createInQbo` (Pattern D, leader-correct), best-effort
   with webhook-expectations write-ahead; `fail: continue` (deferred, reflected later).

## Guarantees

- Idempotent re-entry: re-calling with a matched contact reuses, never duplicates (full once gap 5 lands).
- QBO failure never blocks the caller — `qbo: deferred` plus the expectations WAL repairs later.
- A customer existing without any lead/work-order is a valid terminal state (safe seam).

## Revision 2026-06-10: address-first dedup (business rule)

> **Business rule:** there can never be more than one ACTIVE account at one service address
> at a time. Enforced in the database as a partial unique index over active
> `service_locations` rows on a normalized address key — not only in code.

This makes the service address the PRIMARY dedup axis; contact matching becomes the
secondary axis (it catches the opposite event: same person at a NEW address — a move).

- **Query:** `find_account_by_address(normalized_address)` `[api]` — fired when the form
  receives a full address (autocomplete selection; the zip-level area check stays in-browser).
  Returns a discriminated result: `address_free` (+ create token) | `address_taken`
  (+ masked account identity + tenancy_token). Website responses are masked and
  rate-limited (address probing must not enumerate customers); staff responses are full.
- **Tenancy, not account:** an override ends the old account's ACTIVE location row
  (end-dated, history preserved — the account itself and its billing survive) and creates
  the new account's active row. "The pool stays; people move."
- **Tenancy token (OCC for human decisions):** the query response carries a short-lived
  token encoding exactly what the user was shown (account id + tenancy version). The
  subsequent command requires it; if the state changed between showing the dialog and
  confirming, the token no longer matches and the server re-prompts instead of acting
  on stale information.
- **Trust-tiered confirmation, one implementation:**
  - internal: staff sees "this will override the current customer at this address" →
    `override_address_tenancy` RPC commits immediately (atomic: end old, create new; guarded
    by the token).
  - website: visitor's "that's not me" files `request_address_override` — the lead is
    created and proceeds in limited mode; a pending-override row lands in an office queue;
    staff approval calls the SAME `override_address_tenancy` RPC. Approval and immediate
    paths share one implementation.

## Open design questions

- Should the customer record carry the office? Today office lives on the lead only and is
  re-derived from billing zip. See lead-intake open questions, gap 1 note.

## Homes

- Code (planned): `lib/entities/customer/queries.ts` (find) + `mutations.ts` (create, resolve composer).
- Known callers: [lead-intake-to-conversion](../flows/lead-intake-to-conversion/index.md) step 2;
  the internal form's dedup check (`/api/leads/check-dedup`, query only). Future: any walk-in /
  repair intake. Live caller list: find-all-references on the exported functions.
