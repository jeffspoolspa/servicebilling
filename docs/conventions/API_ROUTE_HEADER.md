# Next.js API route header convention

> Status: [active]
> Last updated: 2026-05-28

Every Next.js API route under `app/api/` (typically `route.ts`) gets a JSDoc-style comment block above the exported handler. Shorter than [SCRIPT_HEADER.md](SCRIPT_HEADER.md) because Next.js conventions already convey a lot.

## The shape

```typescript
/**
 * <Verb> <noun phrase>. <One-sentence summary.>
 *
 * Module: docs/modules/<module-path>.md
 * Auth: <one of: none / signed-in / role:admin / service-token / signed-customer-token>
 *
 * Tables touched:
 *   <table.name>           [read]   <what we read>
 *   <table.name>           [write>  <what we write>
 *
 * External APIs:
 *   - <api>: <endpoint(s) called>
 *
 * Triggered by:
 *   - <UI component path or external caller>
 *
 * Why this exists:
 *   <Short paragraph if non-obvious. Otherwise omit.>
 */
export async function POST(req: Request) {
  // ...
}
```

## Concrete example

From a hypothetical `app/api/billing/invoices/[id]/charge-balance/route.ts`:

```typescript
/**
 * Charge the remaining balance on an invoice via the customer's saved card.
 *
 * Module: docs/modules/service/billing.md
 * Auth: signed-in (uses guardApi)
 *
 * Tables touched:
 *   billing.invoices                  [read]   verify status='ready_to_process'
 *   billing.customer_payment_methods  [read]   look up target_payment_method_id
 *   billing.processing_attempts       [write]  write-ahead log before QBO call
 *
 * External APIs:
 *   - Windmill: triggers f/service_billing/process_work_order via triggerScript
 *
 * Triggered by:
 *   - UI: components/billing/InvoiceDetail.tsx -> "Charge Now" button
 *
 * Why this exists:
 *   The charge step is a Windmill script (not inline in this route) because
 *   it needs the concurrency_key=qbo_writer budget shared across all
 *   QBO-write paths. This route is a thin auth+launcher.
 */
import { guardApi } from "@/lib/auth/api";
import { triggerScript } from "@/lib/windmill";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  // ...
}
```

## Rules

1. **Top sentence starts with a verb.** "Charge", "List", "Update", "Refresh". Read-only routes start with "Return" or "List".
2. **Auth field is required.** Even `Auth: none` (for public endpoints like webhooks) makes the openness explicit.
3. **Tables touched** uses the same label vocabulary as everywhere else.
4. **"Triggered by"** is the entry point — which UI component, which external service. Helps trace orphan routes.
5. **"Why this exists"** is OPTIONAL for routes (unlike scripts) because route logic is usually obvious. Include it only when the route is doing something non-obvious (e.g., this route launches a Windmill script instead of handling inline, because of concurrency).

## Webhook routes

For routes under `app/api/webhooks/`, also document:

```typescript
/**
 * ...
 * Webhook source: QBO (Intuit) | Resend | RingCentral | Gmail Pub/Sub
 * Webhook verification: <svix | hmac-sha256 | bearer-token | none-and-why>
 * ...
 */
```

External webhook handlers need explicit verification documentation because skipping verification is a security failure that's invisible in code review without this section.

## Retrofit policy

Same as scripts: only when next touching the file. The audit and module docs already capture what each route does in aggregate; per-route headers are for debugging at the file level.
