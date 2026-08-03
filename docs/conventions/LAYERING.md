# Layering rules for domain modules

> Status: [active]
> Last updated: 2026-08-03

How a domain-driven module is layered in this repo, and exactly which calls
must route through an application service. Settled on the routing module
(the pilot); every module refactored to the domain model follows this.
Reference implementation: `lib/domain/routing` + `lib/application/routing` +
`lib/infrastructure/routing` + `app/(shell)/maintenance/routes`.

## The layers

| Layer | Lives in | May import | Contains |
| --- | --- | --- | --- |
| Domain | `lib/<module>/domain` | nothing outside itself | aggregates, value objects, domain services, factories, events, PORT INTERFACES |
| Application | `lib/<module>/application` | its domain; one concrete infra type where there is exactly one (see below) | one named service; one method per boundary-crossing use case |
| Infrastructure | `lib/<module>/infrastructure` | its domain, vendor SDKs | repository/cache/gateway implementations |
| Integration | `lib/external/<system>` | nothing domain-specific | one object per external system + its ACL (ADR 012) |
| UI | `app/` | domain (types + calls), application via API routes | formatting and gesture-wiring only |

The domain imports nothing from the other layers. That is the rule that makes
it runnable anywhere - including the browser, which the workbench pattern
below depends on.

> **Attribution, so nobody cites the wrong book.** "Dependencies point inward,
> always" is Hexagonal / Onion / Clean Architecture, not Evans. In the Blue
> Book's layered architecture Infrastructure sits at the BOTTOM and serves the
> layers above, so an application service using an infrastructure class is
> ordinary Evans layering. We keep the stricter inward rule for the DOMAIN
> (it buys testability and browser-portability) and relax it for the
> application layer where a port would only rename one class.

## File layout: layer first, module second, one file per building block

```
lib/domain/<module>/        aggregates, value objects, domain services, ports
  index.ts                  the PUBLISHED CONTRACT — everything above imports here
  <aggregate>.ts            one file per aggregate (customer.ts, task.ts, quota.ts)
  values.ts                 the module's value objects (several per file is fine)
  ports.ts                  interfaces the domain needs implemented
  selfcheck.ts              assert-based, `npx tsx <path>` — no framework
lib/application/<module>/   one file per named service, one method per use case
lib/infrastructure/<module>/ repositories, caches, gateways for that module
app/(shell)/<area>/         pages; formatting and gesture-wiring only
```

Not one file per class: a file holds a BUILDING BLOCK. `values.ts` may carry
four value objects that only make sense together; an aggregate with a big
lifecycle gets its own file. The test is whether a reader looking for a rule
knows which file to open.

**Nothing above the domain imports a file INSIDE a domain module** — imports
go through `index.ts`. That is what makes the contract real rather than
aspirational: renaming a file inside the module cannot break a caller.

Modules today: `routing` (reference), `customers`, `maintenance`.

## External systems are BOUNDED CONTEXTS, not modules of ours (ADR 012)

`lib/external/ion/` and `lib/external/qbo/` sit beside the domain modules, not
inside one, and they deliberately have NO `domain/` folder. QBO's customer
model and ION's task model belong to those systems; ours is not the place to
model them. What lives here is the RELATIONSHIP — in Evans' vocabulary we are
Conformist to QBO on customer identity (it is the leader) and we run an
Anticorruption Layer at both borders, which is his facade + adapter +
translator, spelled `Ion`/`Qbo` (transport, auth) plus `acl.ts` (translation).

One object per system also because a single ION object serves routing (publish
a week), maintenance (open a task) and customers (resolve an id). Each holds:

- `<system>.ts` — one class per system; ALL of its communication; no domain
  logic. Credentials are minted by exactly one Windmill script per system,
  and nothing else may touch them.
- `acl.ts` — the anti-corruption layer: translation both directions, no HTTP.
- `selfcheck.ts` — the translation rules, asserted.

A second gateway for a system that already has one is the mistake this
layout exists to prevent.

## Ports versus concrete dependencies [decided 2026-08-03]

The domain declares a port when the DOMAIN needs something implemented
(`TaskRepository`, `TaskGateway`). An APPLICATION service may instead take
the concrete infrastructure class as a TYPE-ONLY import when there is exactly
one implementation — `OnboardingService(customers, qbo, resolveAddress)`.

Why this is allowed: the runtime dependency is still inverted (the service
never constructs its collaborators; callers inject them), the type import is
erased from the build, and an interface with one implementation named after
the class it wraps is ceremony that hides the real collaborator's name. The
rule: **extract a port the day a second implementation appears**, not before.

The line that does NOT bend: no application or domain file may perform I/O
itself, and no domain file may import infrastructure at all, type or value.

## The one rule about writes

**Every DURABLE write goes through exactly one named application-service
method.** Durable means the write crosses a boundary: persistence, an
external system (QBO, ION, Google), or anything transactional. The
application method owns the crossing: load via repository, invoke the
domain, save, publish. It decides nothing - all rules live in the domain.

**In-memory edits to a what-if do NOT route through the application layer.**
A workbench page (the routing map) holds a live domain model in the browser;
gestures call aggregate methods directly (`scenario.moveStop(...)`) and
re-render. There is no boundary crossing, so an application method there
would orchestrate nothing - a forwarding line, which this repo's house rule
forbids (no functions that do not correspond to a DDD building block). The
what-if commits through the application layer when it is saved or adopted -
that call IS the transaction.

This is the book's rule, stated portably. In the Evans cargo sample every
interaction routes through an application service because every interaction
crosses a process-and-persistence boundary (server app, DB-resident state).
The rule was always about the crossing, not about the aggregate's front door.

## Where rules are enforced - two modes, one home

All rules live on the domain objects. They are enforced in two modes:

1. **Instantaneous invariants throw at mutation.** States the model must
   never hold, even briefly: a stop without a tech, a second visit on a
   weekday the quota already has. `Quota.place`/`move` throw
   `QuotaRuleError`; the UI's only job is relaying the message.
2. **Whole-state invariants are domain queries enforced at gates.**
   Coverage and spacing are evaluated (`quota.coverage()`, `quota.spacing()`),
   not thrown, because a what-if must pass through illegal intermediate
   states (unassign -> owed -> rebuild). The adoption gate
   (`Scenario.adoptionBlockers()`) refuses the durable commit while any
   fail; proposal engines consult the same queries so they never suggest
   what the gate must refuse.

**Aggregate or domain service? Ask what the rule READS, not who calls it.**
A rule that reads one aggregate's own state lives on that aggregate, even
when its callers are all services (`Quota.refusal` reads one quota's stops).
A rule that spans state no single aggregate owns is a domain service that
DELEGATES the single-aggregate part (`Optimizer.verify` asks
`quota.refusal(...)`, then adds the route-capacity and pool-cap checks -
plan-level concerns a quota cannot see). An aggregate that needs a service
to know its own legality is not a consistency boundary; a service holding
one entity's rules is an anemic model.

**No caller re-encodes a rule.** Anything that needs to ask "would this
placement be legal?" calls the aggregate's refusal query
(`Quota.refusal(techId, weekday, ignoring?)`) - reassign's skip reasons,
the optimizer's candidate filter, and fit's exclusions are all callers of
that one method. The failure mode this prevents: three sites each holding
their own fragment of the rule, drifting until one of them lets an illegal
plan through (found live: one-visit-per-day existed only in the pre-checks
until 2026-07-31; the aggregate now owns it).

## Instantiation

The UI never assembles domain objects from parts:

- creation - factories (`RouteFactory`), invariant-checking constructors
  (`Pin.fromTrusted`; raw-coordinate constructors are private)
- reconstitution - repositories server-side; `fromSnapshot` at the
  serialization boundary (server components flatten aggregates to plain
  snapshots; the client's first act is rebuilding real instances)

## How the UI knows the shapes

The domain's `index.ts` is its published contract. The UI imports TYPES
(compile-time only, erased from the build) and the classes it is a client
of. Smart-UI is the antipattern to police: any `if` in a component that
encodes a business rule belongs in the domain. The UI forwards gestures
and formats results - nothing else.

## When a workbench page grows

A page holding a long-lived what-if accumulates handlers (apply, revert,
enter-draft, save) that are a proto-application-service. When the component
gets heavy, gather them into a named client-side session facade (e.g.
`PlanningSession` wrapping the scenario, busy flags, and the API calls) -
an application-tier object that happens to live in the browser. That is a
real refactor with a real payoff, not ceremony; do it when the page next
needs major work, not preemptively.

## Checklist for refactoring a module onto this pattern

1. Domain library first, pure, with ports as interfaces. Selfchecks in
   `selfcheck.ts` (assert-based, runnable with `npx tsx`).
2. Infrastructure implements the ports against Supabase/vendor APIs.
3. One application service; a method per durable use case; thin.
4. API routes call the application service; never the infrastructure
   directly from a component.
5. Pages read via server components -> snapshots -> `fromSnapshot`.
   Interactive pages hold the model client-side; durable writes go back
   through the API.
6. Anti-corruption layer last, where an external system's vocabulary must
   not leak in (ION -> ScheduleObservations).
