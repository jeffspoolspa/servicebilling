# Windmill script header convention

> Status: [active]
> Last updated: 2026-05-28

Every Windmill script (`.py` or `.ts` under `f/` or `u/`) must start with a comment block in this shape. The header is required for review and for AI navigation.

## The shape

```python
# f/<module>/<script_name>
#
# <One-sentence summary of what this script does.>
#
# Module: docs/modules/<module-path>.md
# Status: [active] | [deprecated] | [draft]
# Concurrency key: <key from CONCURRENCY_KEYS.md>
#
# Triggered by:
#   - <one bullet per trigger source: schedule, webhook, pg_net, parent script>
#
# Tables touched:
#   <table.name>           [read]   <what we read it for>
#   <table.name>           [write]  <what we write to it>
#   <table.name>           [r/w]    <what we do>
#
# External APIs:
#   - <api>: <endpoint(s) hit>
#
# Why this exists:
#   <One paragraph explaining the design decision that led to this script.
#   Include empirical evidence (specific WO IDs, URLs, error messages) when
#   the script was created to fix a bug. This is the most important section
#   for future debugging.>

import ...
```

## Concrete example

From a hypothetical update to `f/service_billing/dispatch_pre_processing.py`:

```python
# f/service_billing/dispatch_pre_processing
#
# Outbox-pattern worker that drains awaiting_pre_processing invoices every 60s.
#
# Module: docs/modules/service/billing.md
# Status: [active]
# Concurrency key: qbo_api
#
# Triggered by:
#   - schedule: f/service_billing/dispatch_pre_processing_60s (every 60s)
#
# Tables touched:
#   billing.invoices        [read]   find rows with billing_status='awaiting_pre_processing'
#                                    AND subtotal_ok=TRUE
#   billing.invoices        [write]  via in-process call to f/service_billing/pre_process_invoice
#
# External APIs:
#   - QBO: only via pre_process_invoice (this dispatcher doesn't hit QBO directly)
#   - OpenAI: only via pre_process_invoice (memo generation)
#
# Why this exists:
#   The original design fired pre_process_invoice via pg_net.http_post from
#   a row trigger on work_orders. pg_net is at-most-once and dropped ~3 of
#   50 requests under burst load during a bulk QBO sync (2026-04-15),
#   leaving 8 service-billing invoices stuck at billing_status =
#   'awaiting_pre_processing' with no UI visibility. This dispatcher polls
#   every 60s as the backstop. Pre_process is idempotent, so re-running on
#   a row that's already been processed is safe.

import time
...
```

## Rules

1. **First line is the script's full Windmill path** (no `.py` extension). Makes the file searchable.
2. **Module link uses standard markdown path** so AI agents can navigate from the script to its module doc.
3. **Concurrency key is the canonical name from [CONCURRENCY_KEYS.md](CONCURRENCY_KEYS.md).** If the script doesn't need concurrency control, write `Concurrency key: (none)` and justify in "Why this exists".
4. **Tables touched** uses the same `[read]/[write]/[r/w]` labels as everywhere else. Schema-qualified names.
5. **External APIs** lists every external system the script reaches, even indirectly through helpers.
6. **"Why this exists"** is the most important section. Include specific dates, IDs, or URLs when the script was written to fix a bug. Future-you will be debugging at 2 AM and this is what helps.

## When to update the header

- The script gets a new trigger source: update "Triggered by"
- The script starts touching a new table: update "Tables touched"
- The bug it was originally fixing recurs in a new shape: append a paragraph to "Why this exists"
- The module structure changes: update the module link

## When NOT to retrofit

Per the [retrofit policy](../README.md), only retrofit headers when next touching the file. Don't bulk-rewrite the 122 scripts for header consistency. The 5 reference scripts that DO get retrofitted are listed in [/.../retrofit-headers task](#).

## Helpers

`scripts/check_script_headers.py` (TODO — not built yet) will lint script headers for required sections and report missing pieces.
