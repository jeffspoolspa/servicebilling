# Layering rules for domain modules

> Status: [active]
> Last updated: 2026-07-31

How a domain-driven module is layered in this repo, and exactly which calls
must route through an application service. Settled on the routing module
(the pilot); every module refactored to the domain model follows this.
Reference implementation: `lib/domain/routing` + `lib/application/routing` +
`lib/infrastructure/routing` + `app/(shell)/maintenance/routes`.

## The layers

| Layer | Lives in | May import | Contains |
| --- | --- | --- | --- |
| Domain | `lib/domain/<module>` | nothing outside itself | aggregates, value objects, domain services, factories, events, PORT INTERFACES |
| Application | `lib/application/<module>` | domain | one named service; one method per boundary-crossing use case |
| Infrastructure | `lib/infrastructure/<module>` | domain (to implement its ports), vendor SDKs | repository/publisher implementations |
| UI | `app/` | domain (types + calls), application via API routes | formatting and gesture-wiring only |

Dependencies point inward, always. The domain imports nothing from the other
three. This is the rule that makes the domain runnable anywhere - including
the browser, which the workbench pattern below depends on.

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
