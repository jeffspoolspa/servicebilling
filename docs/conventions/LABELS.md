# Labels — text annotation vocabulary

> Status: [active]
> Last updated: 2026-05-28

The vocabulary for status, read/write annotations, and trigger relationships in all docs. **Replaces emoji indicators entirely.** No exceptions.

## Read/write on a table

| Label | Meaning |
|---|---|
| `[read]` | Script/code reads from this table (SELECT, `.select()`, `.from_('x')`) |
| `[write]` | Script/code writes to this table (INSERT/UPDATE/DELETE, `.insert()`, `.upsert()`, `.update()`, `.delete()`) |
| `[r/w]` | Both reads and writes the table |
| `[trigger]` | Postgres trigger writes the table — code may not touch it directly |
| `[derived]` | Populated by a view, generated column, or materialized rollup. Not written by any script |

Example usage in a module doc:

```
| Table | Reference |
|---|---|
| billing.invoices | f/service_billing/pull_qbo_invoices.py [r/w], f/service_billing/refresh_invoice.py [r/w] |
| billing.drift_log | f/service_billing/cdc_reconciler.py [write] |
| public.work_orders_history | [trigger] public.work_order_history_trigger |
```

## Status on a doc, module, table, or script

| Label | Meaning |
|---|---|
| `[active]` | In use, maintained, do not modify casually |
| `[stub]` | Placeholder; structure exists but content is incomplete. Safe to extend |
| `[deprecated]` | No longer in use; pending deletion. Do not extend |
| `[orphan]` | No code references it, no triggers populate it, no functions read it. Cleanup candidate |
| `[external]` | Owned by another repo (e.g., check_buddy, lead-form site). This repo only reads from / writes to it via documented contracts |
| `[draft]` | Document is still being written. Don't follow guidance in it yet |

## Verification status (flow docs specifically)

A flow diagram can be a DESIGN (what we want) or a DESCRIPTION (what the code does). These must never be confused — an aspirational diagram read as reality is dangerous. Every flow doc declares which it is:

| Label | Meaning |
|---|---|
| `[design]` | The intended flow. Drawn first; code may not match yet. This is the spec to build toward. |
| `[verified]` | Confirmed against the code. The diagram and the actual behavior agree as of the "Last verified" date. |
| `[drift]` | The code diverges from this diagram. The doc lists the divergences. Either the code is wrong (a bug) or the diagram is stale (needs updating). |

Workflow:
- **New flow**: start `[design]`, draw the diagram, build the code, then flip to `[verified]` once code matches.
- **Existing flow**: reverse-engineer to `[verified]` (or `[drift]` if you find the code doesn't match what you expected).
- A `[verified]` flow that later breaks gets marked `[drift]` until reconciled.

Every doc's first quote-line is its status: `> Status: [active]`.

## Trigger/event relationships

| Label | Meaning |
|---|---|
| `[trigger]` | Postgres trigger (fires on INSERT/UPDATE/DELETE of a specific table) |
| `[schedule]` | Windmill cron schedule |
| `[webhook]` | External system POSTs into our API (Gmail label, RingCentral, QBO, etc.) |
| `[manual]` | Triggered by a human via UI button or CLI |

## Flow kind + edge types (see ADR 001)

Flow kind:

| Label | Meaning |
|---|---|
| `[sync]` | Keeps a cached entity current with its external leader (and reflects our writes back). Lives in `flows/sync/`. |
| `[orchestration]` | Drives a business process across entities. Lives in `flows/`. References sync flows at its boundaries. |

Orchestration-flow edge types:

| Label | Meaning |
|---|---|
| `[internal]` | Our derived state changing (cache → cache), driven by our own logic |
| `[write-out -> <system>]` | We push to an external leader (our app → QBO/Intuit/etc) |
| `[reflection <- <system>, via <sync flow>]` | The leader's change flows back to our cache; mechanism lives in the named sync flow |

## Entity source (see ADR 001)

Every entity doc declares its source:

| Label | Meaning |
|---|---|
| `[native]` | We own it; no external leader (e.g., `processing_attempts`, `drift_log`) |
| `[cache: <system>]` | Mirrored from an external leader (e.g., `[cache: QBO]` for `billing.invoices`) |
| `[cache: <system> + native]` | Mixed — some columns mirrored, some ours (per-column leadership, e.g., `public.work_orders` is `[cache: ION + native]`) |

Example:

```
trg_request_pm_refresh_on_invoice_insert [trigger] on AFTER INSERT billing.invoices
  -> pg_net.http_post -> f/service_billing/pull_customer_payment_methods
```

## Anti-pattern: emojis

The previous SYSTEM_MAP and audit docs used the inbox-tray, outbox-tray, counterclockwise-arrows, fishhook, satellite, and red-circle emoji (and many more) as visual indicators. **All emojis are banned going forward** because:

1. They render inconsistently across terminals, IDEs, GitHub, and AI agent interfaces
2. AI agents tokenize them oddly, sometimes spending tokens on no semantic content
3. They can't be grep'd, sorted, or filtered programmatically
4. They look like decoration when the goal is precise annotation
5. They drift in meaning (does the red-circle indicator mean "broken", "important", "deprecated", or "needs attention"?)

Text labels in brackets fix all five problems. Use them.

## Adding a new label

If a documentation pattern needs a label that's not on this list, add it here first, then use it. New labels should follow `[lowercase-hyphenated]`. PR review verifies the label is documented before it's used elsewhere.
