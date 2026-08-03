# Events, commands, and the loop that advances them

> Status: [active]
> Written 2026-08-03, after designing the customer-onboarding and
> maintenance-billing workflows and discovering we had invented names for
> things the literature already names.
> Sits under [ADR 008](../adrs/008-inbox-single-writer-sync.md) (queue/drainer
> runtime) and [ADR 010](../adrs/010-domain-event-stream.md) (the fact log).
> This doc is the VOCABULARY and the decision rules; those two are the
> mechanics.

## Why this exists

We kept re-litigating the same question — "should this be an event?" — in
every workflow, and answering it with different words each time. Almost every
distinction we needed already has a name. Using the names ends the argument,
because the name carries the rule.

## The one distinction everything else hangs off

| | **Command** | **Domain event** |
|---|---|---|
| Grammar | imperative: `OpenTask`, `ChargeInvoice` | past tense: `TaskOpened`, `InvoiceCharged` |
| Means | this is OWED | this HAPPENED |
| Can it be refused? | yes — a command may be rejected | no — you cannot refuse the past |
| Handlers | exactly one | zero or many, none of whom the publisher knows |
| Retried? | yes, until it succeeds or dead-letters | never; you re-handle, you don't re-happen |
| Lives in | a queue table (ADR 008) | the fact log (ADR 010) |

**We had been calling commands "work items."** That was right in substance
and wrong in vocabulary; the word is *command*, and it comes from the CQRS
line of work (Young, Dahan), not from Evans.

The test, applied to real cases from this repo:

- "link this customer to ION, three tries then a person looks" — refusable,
  retried, one owner, has a terminal state. **Command.**
- "this customer was linked to ION" — cannot be refused, several modules may
  care, and it is still true in 2030. **Event.**
- "build this month's invoices" — **command.** "The month was locked" —
  **event.**

A system that chains required steps with events has built an unreliable job
queue. A system that notifies other modules with commands has coupled the
publisher to every consumer. Both failures are avoided by asking the two
questions above.

## Where each canonical pattern actually applies here

| What we built | Its name | Source |
|---|---|---|
| `ExternalRef.awaiting(since, attempts)` instead of a null column | **Make Implicit Concepts Explicit** | Evans, Ch. 9 |
| `unclaimed()`, `lockBlockers()`, `adoptionBlockers()`, the nine gate checks | **Specification** — an object that answers "does this satisfy the criteria", can select matching objects, and *reports why it failed* | Evans, Ch. 9 |
| `IonTaskAcl`, `IonCustomerDirectory` | **Anticorruption Layer** (facade + adapter + translator) | Evans, Ch. 14 |
| Accepting QBO's customer model rather than negotiating | **Conformist** | Evans, Ch. 14 |
| `BillableVisit` — billing consumes delivery FACTS, not delivery's aggregates | **Customer/Supplier** + **Published Language** | Evans, Ch. 14 |
| Aggregates accumulating facts, drained by whoever saves them | **Domain Events** — added to the canon AFTER the Blue Book, in Evans' later Reference; developed at length by Vernon | Evans (Reference), Vernon Ch. 8 |
| The onboarding chain that remembers where it got to | **Process Manager** (often loosely called a Saga; a saga proper is Garcia-Molina's long-lived transaction with compensations) | Vernon, Ch. 12 |
| One aggregate per transaction, others follow after | **Eventual consistency between aggregates** | Vernon, Ch. 10 |
| Deciding which modules deserve the modeling effort | **Core Domain distillation** — routing and maintenance pricing are CORE; the billing document layer is SUPPORTING; QBO and ION are GENERIC/external | Evans, Ch. 15 |

## Where we deliberately depart, and why

**Level-triggered, not edge-triggered.** Vernon's process manager advances
when a message ARRIVES. Ours advances when a sweep OBSERVES state: "which
months are due for their next step", "which customers are owed a link
attempt". The event still fires — it just buys latency, not correctness.

This is not a DDD idea; it comes from control systems (and is the same choice
Kubernetes makes with its reconcile loops). We adopt it because our failure
modes are asymmetric:

- a missed invoice or an unlinked customer is unacceptable
- a day of latency is fine

Edge-triggered choreography fails silently when a message is dropped — and
`pg_net` drops roughly 6% under burst, which we have measured. Level-triggered
re-derivation cannot fail silently, because the next pass asks the same
question again. So:

> **Events give latency. State queries give correctness.**
> Never let a fact's delivery be the only thing standing between a customer
> and their invoice.

The one place a fold over facts IS the truth — the balance, per ADR 010 — is
safe for the opposite reason: those facts are themselves the record, and the
fold carries a checksum.

## Decision rules

1. **Required next step in one process?** Command on a queue, advanced by the
   loop. Record the fact too, but never depend on it.
2. **Another module might care?** Event. The publisher must not know who
   subscribes; the subscriber lives in the CONSUMING module.
3. **Same aggregate?** Just call the method. Publishing to yourself is
   ceremony.
4. **A rule that must hold at every instant?** Aggregate invariant, thrown at
   mutation.
5. **A rule that a work-in-progress may legitimately violate?** Specification,
   asked at the gate — and it should report WHICH criteria failed, not a bare
   false.
6. **Concurrency you cannot see from inside one aggregate?** A database
   constraint as the backstop. The rule's home is still the aggregate; the
   index is the seatbelt.

## Handler obligations

Every command handler is **idempotent** and **re-reads state at claim time**.
The queue row carries a unit key, never a payload snapshot: enqueue-time
snapshots go stale, claim-time reads cannot. Re-reading also makes idempotency
nearly free — a handler that re-derives from current state no-ops on a second
run.

Every subscriber is **thin**: it translates a fact into a call on an existing
application-service method. The moment a subscriber makes a decision, there
are two paths to one outcome and they will drift.

## What the database keeps

Moving domain logic out of SQL does not mean emptying it. It keeps:

- **constraints as backstops** — uniqueness, exclusivity, foreign keys
- **candidate queries** — set-based work, as views ("which invoices might be
  gateable"), never the judgment itself
- **detectors that ENQUEUE** — a trigger on a state transition inserts a
  command; it must not decide. `if ready then insert` is the shape we are
  removing (see `billing.enqueue_charge_if_ready`, whose `invoice_ready()`
  call hides a six-month credit window and a memo regex in a `not exists`).

Row-level triggers on hot tables are how we produced 706k executions in a
month. Enqueue per unit, on a transition, coalesced.

## Migration pattern for moving a decision out of SQL

Established by the billing model's Phase 1 and reusable: **shadow, compare,
cut over.** Run the domain implementation beside the SQL one on live data,
record both verdicts, and switch only after they agree for long enough to
trust. Because a Specification reports per-criterion results rather than a
bare boolean, a disagreement tells you WHICH rule diverged.
