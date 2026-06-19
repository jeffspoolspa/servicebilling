# Website cutover — point the site at the app's shared endpoints

> Status: [planned]
> Flow: [index](index.md)
> Architecture rationale: [ADR 004](../../adrs/004-leads-canonical-model.md)

The app now hosts the canonical intake, quote, and address endpoints. This is the
checklist to migrate the public website (`perfectpools-redesign`) off its own
implementations — the `website-lead-intake` edge function, its duplicated quote
formula, and its client-side Google Places — onto the app's shared endpoints. Do
this once everything below is ready.

## Shared endpoints the website will consume

| Endpoint | Replaces (on the website) | Auth |
|---|---|---|
| `POST /api/leads` | `website-lead-intake` edge function | `x-api-key` |
| `POST /api/leads/quote` | duplicated quote formula | `x-api-key` |
| `GET /api/places/autocomplete` | client-side Google Places widget | `x-api-key` |
| `GET /api/places/staticmap` | (optional) address map image | `x-api-key` |

## A. App-side prerequisites (do these first)

1. [ ] Add an `x-api-key` path to `/api/places/autocomplete` + `/api/places/staticmap`
   (currently session-gated only). Reuse `LEADS_INTAKE_API_KEY` or mint a new key.
2. [ ] Add CORS (`Access-Control-Allow-Origin` for the website origin + an `OPTIONS`
   preflight handler) to all four routes — these are browser-origin calls, so the
   browser blocks them without CORS.
3. [ ] Set Vercel (app) env: `MAPBOX_TOKEN`, `LEADS_INTAKE_API_KEY`, and the comms
   creds needed for the intake auto-send quote — `RESEND_API_KEY`,
   `RESEND_TEMPLATE_LEAD_QUOTE`, `RC_APP_CLIENT_ID`, `RC_APP_CLIENT_SECRET`,
   `RC_JWT_PP`, `RC_JWT_USER`.

## B. Website repo changes (`perfectpools-redesign`)

4. [ ] Lead intake: change the POST from `…/functions/v1/website-lead-intake` to
   `https://<app>/api/leads`, add header `x-api-key: <LEADS_INTAKE_API_KEY>`. The
   JSON body `{account, bodies, lead}` is unchanged.
5. [ ] Live quote: point at `POST https://<app>/api/leads/quote` (same `x-api-key`),
   body `{primaryBodyType, additionalBodyCount, visitsPerWeek}`. Delete the
   website's duplicated quote formula.
6. [ ] Address autocomplete: replace the client-side Google Places widget with a
   fetch to `GET https://<app>/api/places/autocomplete?q=…` + a custom dropdown
   (port the app's `MapboxAddressAutocomplete`). Remove the website's Google Maps
   JS + key. Standardized street/city/state/zip come back from the response.
7. [ ] (optional) Address map: use `GET /api/places/staticmap?q=…`.
8. [ ] Website env: set `LEADS_INTAKE_API_KEY` (the SAME value as the app).

## C. After traffic is on the app (cleanup)

9. [ ] Retire edge functions: delete `website-lead-intake`; drop `sync-customer-qbo`
   from the intake path (keep it for its other callers).
10. [ ] Verify the QBO customer create in prod — the Pattern D create is exercised
    by real website traffic for the first time (the old chain silently no-op'd new
    customers via update-only `sync-customer-qbo`).

## Why the app side, not the edge function

The intake orchestrator must call the app-owned QBO write-through (Pattern D create),
the chemical-aware quote engine, the comms stack (auto-send + `communications`
logging), and the campaign engine. Re-implementing those in the Deno edge function
would duplicate them; consolidating on the app collapses to one implementation. The
`website-lead-intake` edge function does NOT create new QBO customers and uses a
chemical-blind quote. See [ADR 004](../../adrs/004-leads-canonical-model.md) and
[open-questions](open-questions.md).
