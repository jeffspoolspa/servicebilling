# Library composition — how we build workflows in this repo

> Status: [active]
> The method behind [ADR 009](../adrs/009-shared-qbo-primitives-lib.md). A
> workflow is not a long script; it is a thin **event handler** that composes a
> shared library of **primitives** and **services**. This doc is the reusable
> system — it applies to billing, ION, or any workflow that acts on an external
> system. Grew out of the July 2026 billing refactor.

## The shape: an event handler, not a workflow script

Think in hexagonal (ports-and-adapters) terms:

- The **frontend fires an event** ("process this invoice", "send this receipt").
- The Windmill script is a **primary adapter**: it receives the event and runs a
  **use-case** — a short sentence of actions.
- Every external effect (charge, send, DB write) lives behind a **port** in
  `f/billing/_lib`. The handler names *what* happens; the library owns *how*.
- **State is derived, not stamped.** The handler records facts
  (`processing_attempts`); `processed` / `needs_review` / `paid` are read-models
  and triggers over those facts. The event calculates nothing about final state.

Swap QBO for Stripe and only the adapter behind the port changes — no handler
is touched.

## The three tiers (put every function in exactly one)

| Tier | Definition | Examples | Home |
|---|---|---|---|
| **Primitive** | ONE external side effect. No state, no `conn`, no policy. | `charge_card`, `send_invoice`, `get_qbo_invoice_details`, `get_db_conn` | `f/billing/_lib/*` |
| **Service** | Idempotent multi-step orchestration. Knows mechanism, NOT the domain. | `charge_and_record` (WAL+fresh-read+charge+payment), `apply_credits` | `f/billing/_lib/payments` |
| **Sentence** | This workflow's policy, composing services + primitives. | `build_intent`, `deliver`, `process`, `main` | the engine file |

Rule of thumb: **share the verb, keep the sentence.** If a function is byte-
identical across workflows, it's a primitive/service → `_lib`. If it encodes one
workflow's policy (an autopay roster, a WO credit rule), it stays in that engine.

## The five steps (in order)

1. **Confirm live before touching.** Deployed ≠ live. Check app/DB triggers +
   run history *first* (REST job history, or the tables a path writes). Dead code
   gets **deleted**, not refactored. (Both `monthly_autopay` and
   `service_billing_processing` were "documented live" but hadn't run in months.)
2. **Tier every function** in the live script.
3. **Extract primitives once, import everywhere.** One implementation per
   external op. (`refresh_qbo_token` had 22 copies; `get_db_conn` had 24.)
4. **Promote shared orchestration to a service; keep divergent policy
   per-engine.** Unify idempotency here — the biggest safety win is one audited
   guarantee instead of three (invoice used a WAL, WO used a lock, the legacy one
   used neither).
5. **Derive state, don't maintain it.** Facts in → read-models/triggers compute
   status. (Autopay declines, invoice processed/needs_review.)

## The three disciplines (threaded through all five)

- **Verified echo** — only write leader-owned columns with values the leader just
  confirmed; write each fact when it becomes known (email at send-time, balance at
  read-time). The auto-promote trigger is the idempotent join.
- **Mechanism vs policy** — the service charges and records; it never learns
  *what kind* of thing it is charging. The moment it does, it has stopped being a
  port and become an engine.
- **Data, not boolean flags** — `receipt_email=None`, never `send_receipt=False`.
  A boolean that switches off half a function means it was two functions.

## Reference: a workflow as an event handler

`f/service_billing/process_work_order` reduced from a 399-line monolith to this
(the `_lib` services it composes are specced in
[ADR 009](../adrs/009-shared-qbo-primitives-lib.md)):

```python
from f.billing._lib.db import get_db_conn
from f.billing._lib.qbo import refresh_qbo_token, send_invoice
from f.billing._lib.payments import (
    charge_and_record, apply_credits, resolve_payment_method, build_line, ChargeIntent,
)

def build_intent(inv, pm):
    return ChargeIntent(
        idempotency_scope=(inv["qbo_invoice_id"], "wo"),
        payment_method_id=pm["id"], channel=pm["channel"],
        lines=[build_line(inv["qbo_invoice_id"])],          # amount read FRESH by the service
        memo=f"WO {inv['doc_number']}", customer_id=inv["qbo_customer_id"],
        receipt_email=inv["email"] if inv["wants_receipt"] else None,   # data, not a flag
    )

def deliver(inv, at, rid):
    if inv["email"] and inv["email_status"] != "EmailSent":
        send_invoice(inv["qbo_invoice_id"], inv["email"], at, rid)      # receipt is in the service

def process(conn, wo_number, at, rid, dry_run):
    inv = load_wo_invoice(conn, wo_number)
    if inv is None:            return {"wo": wo_number, "status": "no_invoice"}
    pm = resolve_payment_method(conn, inv["qbo_customer_id"])
    if pm is None:             return {"wo": wo_number, "status": "no_payment_method"}
    # credits FIRST — lowers the QBO balance; the service reads the remainder fresh,
    # so a fully-credited invoice returns "already_paid" with no charge.
    apply_credits(conn, inv["qbo_invoice_id"], inv["qbo_customer_id"], at, rid, dry_run=dry_run)
    r = charge_and_record(conn, build_intent(inv, pm), at, rid, dry_run=dry_run)
    if r.status in ("succeeded", "already_paid", "declined"):
        deliver(inv, at, rid)          # state DERIVES downstream — nothing stamped here
    return {"wo": wo_number, **r.as_dict()}

def main(wo_number: str, dry_run: bool = True):
    at, rid = refresh_qbo_token(); conn = get_db_conn()
    try:    return process(conn, wo_number, at, rid, dry_run)
    finally: conn.close()
```

One event in → compose two services → one outcome out. Every new billing action
(refund, resend, partial-payment) is another file this short over the same `_lib`.

## Adding a new workflow

1. Write the event handler as `main(event_args)` → a `process()` sentence.
2. Reach for existing `_lib` verbs first. Missing one? Add it at the right tier —
   never inline a second copy.
3. If two workflows now share a multi-step block, promote it to a service.
4. Record facts; let state derive.

## See also

- [ADR 009](../adrs/009-shared-qbo-primitives-lib.md) — the tiers + `charge_and_record` contract
- [ADR 008](../adrs/008-inbox-single-writer-sync.md) — single-writer cache; derive-don't-stamp
- [WINDMILL_DEPLOY.md](WINDMILL_DEPLOY.md) — how to deploy `_lib` + engines
- [runbooks/service-billing-cleanup.md](../runbooks/service-billing-cleanup.md) — this method applied, step by step
