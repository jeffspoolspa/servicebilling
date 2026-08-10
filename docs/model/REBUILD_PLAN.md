# The .NET rebuild — the plan

> Status: [active] — ruled 2026-08-10. Slice model in .NET: ION infra → loop
> populates the new DB → use cases → API. Classes:
> [AGREEMENT_MODEL.md](AGREEMENT_MODEL.md). Rules: [ROUTING_CHANGES.md](ROUTING_CHANGES.md).

## Laws (every phase)

1. One writer per table; one ION-writing system. Handovers = one commit.
2. Dry by default; Carter arms.
3. Writes never blind-retry — re-read state, resume the declaration.
4. Replaced code is deleted in the replacing commit.
5. Every phase ends with a proof.

**Strangler posture:** TS keeps publishing and refreshing the old
`agreements` schema (billing reads it) until Phases 7–8. `.NET` writes only
the new `book` schema — no shared tables, no conflict.

## Phase 0 — Preflight (an evening)

- [ ] Multi-session test: same user, normal + incognito window — does the
      first session survive? → decides pool shape (N sessions vs N users)
- [ ] Create the worker's own ION user
- [ ] Pick host (Railway/Fly, always-on, ~2 GB) · install .NET LTS
- [ ] Scaffold:

```
src/
  Maintenance/
    Entities/
      Agreement/
        Agreement.cs                  aggregate root — slices, lifecycle, one-active invariant refusal
        Slice.cs                      one serviced thing — verbs live here
        Stop.cs                       (id, weekday, tech) entity
        Incarnation.cs                ION id over time — declared/landed/abandoned
        SliceTerms.cs                 VO — cadence + billing + period, versioned
        Cadence.cs                    VO — Weekly|Biweekly|Monthly, TimesPerPeriod, parity anchor
        Billing.cs                    VO — serviceType, price, dayRates (hand-written equality)
        Serves.cs                     VO — WorkType (program) + body label
        Reason.cs                     VO — why the work exists; what it compensates
        SeamPlanner.cs                domain service — anchor first, gap second, bridge on lost firing
        CadenceLaw.cs                 domain service — gap bounds per cadence
        ArrangementDiff.cs            domain service — held vs observed -> ChangeSet
        AgreementRuleException.cs
    Application/
      Ports/
        IAgreementRepository.cs       load + Save (aggregate + facts + floor, ONE transaction)
        IIonTasks.cs                  the six methods, our vocabulary, read-back confirmed
        IVisitHistory.cs              last served across the lineage
        IObservationLog.cs            evidence, never authority
      ConvergeSlice.cs                read ION -> diff -> Reflect -> Save
      ChangeTech.cs                   Reflect -> verb -> Declare -> write -> Land
      ChangeParity.cs                 Preview + Run, same SeamPlanner call
      SweepIonTasks.cs                population diff, list tier
      AttachOrMint.cs                 unknown ION task -> the evidence ladder
    Infrastructure/
      Persistence/
        BookDbContext.cs              EF Core, book schema, EF owns its migrations
        EfAgreementRepository.cs      the one-transaction Save
        SupabaseVisitHistory.cs       reads maintenance.visits + old lineage read-only
      Ion/
        IonTasks.cs                   implements IIonTasks — the only public type
        IonSession.cs                 cookie + origin + primed-to (tracked, never assumed)
        IonSessionPool.cs             leases, minting, customer affinity
        IonSessionKeeper.cs           BackgroundService — ping idle, evict dead, refill
        IonSessionMinter.cs           Playwright login — the ONLY browser code
        IonFormParser.cs              ColdFusion HTML -> raw fields
        IonFormRenderer.cs            slice intent -> form writes
        IonVocabulary.cs              closed decodes; unknown throws
        IonQuirks.md                  the documented weirdness, one place
      Scheduling/
        IonReconciliationLoop.cs      BackgroundService — the 2h driver
        WorkRequestConsumer.cs        BackgroundService — NOTIFY + SKIP LOCKED
        SweepLease.cs                 Postgres advisory lock — one runner
        ReconciliationOptions.cs      intervals, caps, Apply flag
    Presentation/
      SliceEndpoints.cs               parity preview, change enqueue
      ReconcileEndpoints.cs           manual nudge, divergence report
      HealthEndpoints.cs              last sweep, pool state
  Host/
    Program.cs                        DI + role selection — Workers:Ion picks api|worker
    appsettings.json                  intervals, urls; secrets via env
    Dockerfile                        mcr.microsoft.com/playwright/dotnet base
tests/
  Maintenance.Tests/
    Agreement/                        aggregate + verb tests, the parity chain verbatim
    Services/                         SeamPlanner, CadenceLaw, ArrangementDiff
    Application/                      use cases against FakeIonTasks
    Fakes/
      FakeIonTasks.cs                 canned ObservedSlices, scripted confirmations
      InMemoryAgreementRepository.cs
```

## Phase 1 — Pure domain + tests (model mistakes surface HERE)

- [ ] Everything in AGREEMENT_MODEL.md as code. No DB, no ION.
- [ ] Carter's parity chain as a verbatim named test (B→A, Friday, anchor
      21st, gap 20>14, bridge 14th, operator moves it)
- [ ] Tests: supersede-kept-id fails · pending declaration blocks converge ·
      one-time slice never ends the agreement · frequency+stops inseparable ·
      Reflect never re-versions unchanged terms (collection-equality trap)

**Proof:** `dotnet test` green.

## Phase 2 — The book

- [ ] `book` schema, EF migrations: agreements, slices, stops, incarnations,
      slice_terms, facts (outbox), work_requests, observations
- [ ] Partial unique index: one ACTIVE agreement per customer
- [ ] `Save()` = aggregate + facts + floor projection, ONE transaction
- [ ] `IVisitHistory`: lineage-wide last-served (reads `maintenance.visits`
      + old incarnations read-only)

**Proof:** save/reload agree; second active agreement refuses at the DB.

## Phase 3 — ION reads via existing Windmill HTTP

- [ ] `IonVocabulary`: port the closed decodes; unknown → quarantine
- [ ] `WindmillIonTasks`: Read + ListCustomerTasks over the working endpoints
- [ ] `ConvergeSlice` + `AttachOrMint` (evidence ladder, ambiguity quarantines)

**Proof:** dry reconcile of Highlands (two slices) reads exactly as ION.

## Phase 4 — Worker + loop = THE BACKFILL

The loop against an empty book IS the migration: AttachOrMint mints every
agreement from observation. Proves sync and seeds the DB in one motion.

- [ ] `IonReconciliationLoop`: PeriodicTimer, scope/tick, advisory lock,
      failure ceiling, polite delay, `/health` (last sweep + divergences)
- [ ] List tier (~2h, wide) → diff → form tier (narrow) · `LastObservedAt`
- [ ] Deploy container (no Playwright yet) · dry backfill report → review
      (~500 agreements; ELOPER must come out as ONE) → Carter arms

**Proof:** divergences trend to zero; a hand edit in ION lands in one cycle.

## Phase 5 — Own the session (Playwright in container)

- [ ] Image `mcr.microsoft.com/playwright/dotnet` (version pairing = the pin)
- [ ] Pool (leases, one op/session, customer affinity, priming tracked) +
      `IonSessionKeeper` + minter for OUR user · mirrored to Postgres
- [ ] `HttpIonTasks` replaces Windmill on reads; login-page detection;
      reads retry once, writes never · concurrency 2–3

**Proof:** full sweep in minutes, zero Windmill calls; restart → no re-login.

## Phase 6 — First write: ChangeTech

- [ ] Write side: ApplySupersession (list-sandwich confirms born id or
      throws), ApplyAmendment (form re-read), CreateOneTime, Delete
- [ ] `work_requests` + NOTIFY + SKIP LOCKED consumer; steps written to row
- [ ] Canary (Carter fires): one tech-only move through the queue

**Proof:** canary verified in ION + book; kill worker mid-write → pending
declaration RESUMES next pass (test it, don't assume it).

## Phase 7 — ChangeParity + bridges + the app

- [ ] Preview/Run share one SeamPlanner call · bridge = one-time slice
      (`Reason(TransitionBridge)`), own declaration/create/landing
- [ ] API role: preview, enqueue, read models, health
- [ ] Dialog → .NET preview + queue; progress via Supabase Realtime
- [ ] **Cutover commit:** publishes enqueue to .NET; TS publish pipeline
      DELETED same commit

**Proof:** Marie's flip through the dialog — the case that broke the old
pipeline — lands correctly.

## Phase 8 — Retirement (each its own decision)

- [ ] Board reads book floor → TS sweep/nightly off → old schema frozen for
      billing asOf → billing repoint (own project) → task_schedules mirror dies

## What dies when

| TS piece | phase |
|---|---|
| sweep-ion-tasks + sweep script | 4 |
| Windmill ION reads | 5 |
| publish pipeline (runner, change-arrangement, Inngest fn) | 7 |
| refresh-agreement + nightly | 8 |
| converge-placement, v_current_placements, task_schedules | 8 |

## Open

- Multi-session test result → pool shape (+ ION licensing if N users)
- `Serves.BodyLabel`: decode or freeform — decide at Phase 3 with real data
- Supabase Realtime enabled on `book` before Phase 7
