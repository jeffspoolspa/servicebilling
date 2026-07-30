# Library composition — how we build and refactor workflows

> Status: [active]
> The reusable method behind [ADR 009](../adrs/009-shared-qbo-primitives-lib.md).
> A workflow is not a long script; it is a thin **event handler** that composes a
> shared library of **primitives** and **services**. This document is
> domain-agnostic: it defines the model, a decidable transformation recipe, and a
> definition of done. Applied to any long workflow script, following it converges
> on the same shape — a short handler over a shared library. The worked example at
> the end is a verification of the method, not part of its definition.

## The model

Think in ports-and-adapters (hexagonal) terms:

- A **workflow is one event.** Something upstream (a UI action, a DB trigger, a
  schedule) fires it. The handler's entry point receives that event and nothing
  else — its parameters *are* the event payload.
- The handler is a **primary adapter**: it translates the event into a **use-case**
  — a short sentence of actions — and returns an outcome.
- Every effect on an external system (a charge, a send, a write) lives behind a
  **port** in a shared library. The handler names *what* happens; the library owns
  *how*. Replacing the external system changes the adapter behind the port, never
  the handler.
- **State is derived, not stamped.** The handler records *facts*. Any status that
  is a *computed conclusion* over those facts is a read-model or trigger, not a
  column the handler writes.

The payoff compounds: each workflow you build this way deposits reusable verbs the
next one withdraws. Cloning a workflow is the failure mode this prevents — clones
diverge, and they diverge silently in the parts that matter most (correctness,
idempotency).

## The three tiers

Every function belongs to exactly one tier. Decide with the test in the last
column — it is decidable, not a judgment call.

| Tier | Definition | Home | Placement test |
|---|---|---|---|
| **Primitive** | ONE external side effect (or a pure calculation). Holds no state, needs no DB connection. | shared `_lib` | "Is this exactly one call to one outside system, with no bookkeeping?" |
| **Service** | Coordinates several calls with idempotency / ordering / error handling. Makes no decision that depends on *what* is being processed. | shared `_lib` | "Would every workflow that does this want it byte-for-byte identical, regardless of the domain object?" |
| **Sentence** | This workflow's policy: what to act on, which route, what to do with each outcome. | the handler file | "Does changing the business rule change this function?" |

The single most useful question when a function feels in-between: **"Would every
workflow want this identical, regardless of what it's processing?"** Yes → it is a
primitive or a service; extract it. No → it is a sentence; it stays in the handler.

## The transformation recipe

Apply these steps in order to any workflow script. Each step has an action and a
check.

1. **Name the event.** The entry point handles one event; its parameters are the
   whole payload. *Check:* if the entry point branches into fundamentally different
   jobs, it is more than one event — split it into one handler each before going on.

2. **Confirm it is live.** Deployed ≠ live. Check what actually triggers it (callers,
   run history, the tables it writes). *Check:* zero recent runs and no trigger →
   it is dead; **delete it and stop**. The largest refactor is often a deletion.

3. **Tier every function** using the table above.

4. **Extract the primitives.** Move each to the shared library, delete the local
   copy, import it. *Check:* one implementation per external operation exists in the
   whole repo — no second copy anywhere.

5. **Draw the service boundary.** Find the block that carries the *irreversibility*
   (money, external writes) together with its idempotency bookkeeping (the
   write-ahead log / lock / attempt record). That block is a service. Give it an
   **intent in → result out** contract:
   - the intent carries domain choices as **data** (ids, an optional destination),
     never as behavior flags;
   - the service **reads fresh** whatever it needs to decide — never trust a value
     the caller should have verified;
   - it returns a status the caller dispatches on, and it references **no domain
     noun** (no customer type, roster, campaign).
   Move every domain branch out of the service and back into the handler.
   *Check:* the service compiles with no import from the domain; a second, unrelated
   workflow could call it unchanged.

6. **Collapse the sentence.** What remains in the handler must read as one line of
   thought: *receive the event → build the intent → call the service(s) → dispatch
   on the outcome → deliver.* *Check:* if it is longer than that, either mechanism
   leaked upward (push it down into a service) or policy leaked into a flag (pull it
   up into the sentence). Iterate until the body reads as a sentence you can say
   aloud.

7. **Derive the state.** Any column the script *stamps* to record a computed status
   (done, needs-review, in-trouble) becomes a read-model or trigger over the fact
   log. *Check:* the handler writes facts only; no status is written that could be
   computed from facts already recorded.

## The disciplines (what keeps it airtight)

Four rules, each with the smell that signals a violation.

- **Write what you can prove, when you can prove it.** Only write a value into a
  field owned by an external system after that system confirms it; write each fact
  the moment it becomes known, not batched with an unrelated one.
  *Smell:* a hardcoded success value ("set balance = 0 after charging"). Write the
  value you read back, or write nothing and let reconciliation converge.

- **Mechanism, not policy, in shared code.** A service charges and records; it never
  learns what kind of thing it is charging.
  *Smell:* a shared function that branches on a domain attribute. The branch belongs
  to the caller.

- **Data, not boolean flags.** Express a choice as a value the function needs anyway
  (a nullable destination), not a switch that disables part of it.
  *Smell:* a boolean parameter that turns off half a function — that is two
  functions wearing one signature.

- **Share the verb, keep the sentence.** Extract what is identical everywhere; leave
  what encodes one workflow's policy where it is used.
  *Smell:* forcing two workflows through one flow abstraction with mode flags — the
  divergence was real; honor it with two short sentences over shared verbs.

## Definition of done

A refactored workflow satisfies all of these; use them to self-check any output:

- The entry point is the only way in, and its parameters are the entire event.
- Every external effect is an imported library verb; the handler file defines none.
- Idempotency and money bookkeeping live in one service, not in the handler.
- The handler body reads as a single sentence.
- No field is stamped with a status that could be derived from recorded facts.
- No boolean flag turns off half of any function.
- No shared function names a domain noun.

If any line fails, the recipe is not finished — the failing line names the next move.

## Worked example (verification)

Independent proof the method reproduces itself: a ~400-line charge-and-send
monolith, tiered and collapsed by the recipe above, becomes this handler. Its
`_lib` services are specced in
[ADR 009](../adrs/009-shared-qbo-primitives-lib.md).

```python
from f.billing._lib.db import get_db_conn
from f.billing._lib.qbo import refresh_qbo_token, send_invoice
from f.billing._lib.payments import (
    charge_and_record, apply_credits, resolve_payment_method, build_line, ChargeIntent,
)

def build_intent(inv, pm):                                    # sentence: policy as data
    return ChargeIntent(
        idempotency_scope=(inv["qbo_invoice_id"], "wo"),
        payment_method_id=pm["id"], channel=pm["channel"],
        lines=[build_line(inv["qbo_invoice_id"])],            # amount read FRESH by the service
        memo=f"WO {inv['doc_number']}", customer_id=inv["qbo_customer_id"],
        receipt_email=inv["email"] if inv["wants_receipt"] else None,   # data, not a flag
    )

def deliver(inv, at, rid):                                    # sentence: delivery policy
    if inv["email"] and inv["email_status"] != "EmailSent":
        send_invoice(inv["qbo_invoice_id"], inv["email"], at, rid)

def process(conn, wo_number, at, rid, dry_run):               # the use-case, one sentence
    inv = load_wo_invoice(conn, wo_number)
    if inv is None:            return {"wo": wo_number, "status": "no_invoice"}
    pm = resolve_payment_method(conn, inv["qbo_customer_id"])
    if pm is None:             return {"wo": wo_number, "status": "no_payment_method"}
    apply_credits(conn, inv["qbo_invoice_id"], inv["qbo_customer_id"], at, rid, dry_run=dry_run)
    r = charge_and_record(conn, build_intent(inv, pm), at, rid, dry_run=dry_run)
    if r.status in ("succeeded", "already_paid", "declined"):
        deliver(inv, at, rid)                                 # state DERIVES downstream
    return {"wo": wo_number, **r.as_dict()}

def main(wo_number: str, dry_run: bool = True):               # primary adapter: the event
    at, rid = refresh_qbo_token(); conn = get_db_conn()
    try:    return process(conn, wo_number, at, rid, dry_run)
    finally: conn.close()
```

Check it against the definition of done: one entry point (the event), zero external
verbs defined locally, idempotency inside `charge_and_record`, a body that reads as
a sentence, no stamped status, no boolean flag, no domain noun in a shared call.
Every box ticks — which is the point: the same seven steps on a different monolith
land the same way.

## See also

- [ADR 009](../adrs/009-shared-qbo-primitives-lib.md) — the tiers + service contracts, applied to QBO
- [ADR 008](../adrs/008-inbox-single-writer-sync.md) — single-writer cache; derive-don't-stamp
- [WINDMILL_DEPLOY.md](WINDMILL_DEPLOY.md) — deploying library modules + handlers
- [runbooks/service-billing-cleanup.md](../runbooks/service-billing-cleanup.md) — the recipe run end-to-end on one domain
