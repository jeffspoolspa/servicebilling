# The agreement model — classes and use cases

> Status: [active] — written 2026-08-09, before implementation.
> C# because that is the direction; the shape is language-independent.
> Rule for this doc: no class appears without a use case that calls it.

## Structure

RULED 2026-08-09: every module carries the same four layers, and an
aggregate gets its own folder inside `entities/`.

```
maintenance/
  entities/
    agreement/                     THE aggregate, one file per class
      Agreement.cs  Slice.cs  Stop.cs  Incarnation.cs
      SliceTerms.cs  Cadence.cs  Billing.cs  Serves.cs  Reason.cs
      SeamPlanner.cs  CadenceLaw.cs  ArrangementDiff.cs    <- domain services
      AgreementRuleException.cs
  application/
    ports/                         IAgreementRepository, IIonTasks,
                                   IVisitHistory, IObservationLog
    ConvergeSlice.cs  ChangeTech.cs  ChangeParity.cs  SweepIonTasks.cs
  infrastructure/
    persistence/                   repository + the floor projection write
    ion/                           the ACL adapter (parse, render, read-back)
  presentation/
    endpoints
routing/                           same four layers; planning only, reads the floor
```

Two placements worth stating, since the four layers do not name them:

- **Domain services live with the aggregate they serve.** `SeamPlanner`,
  `CadenceLaw` and `ArrangementDiff` are all about slices, so they sit in
  `entities/agreement/`. Only a service spanning aggregates would need
  `entities/services/`.
- **Ports are declared in `application/ports/`** and implemented in
  `infrastructure/`. The entities layer depends on nothing.

## Classes

```csharp
public sealed class Agreement : AggregateRoot<AgreementId>
{
    public CustomerId CustomerId { get; }
    public AgreementStatus Status { get; private set; }
    public DateOnly? EndedOn { get; private set; }
    private readonly List<Slice> _slices;
    public IReadOnlyList<Slice> Slices => _slices;

    public Slice SliceOf(SliceId id);
    public Slice SliceCarrying(IonTaskId id);
    public Slice SliceOfStop(StopId id);
    public SliceId AddSlice(Serves serves, SliceKind kind, SliceTerms terms, Reason why, Instant at);
    public void End(DateOnly on, Instant at, Provenance p);   // ends its slices with it
}

/// ONE serviced thing: the pool; the fountain; chem testing; a one-time QC.
public sealed class Slice : Entity<SliceId>
{
    public Serves Serves { get; }                   // WorkType (the program) + body label
    public SliceKind Kind { get; }                  // Recurring | OneTime
    public Reason Why { get; }                      // why this work exists at all
    public SliceStatus Status { get; private set; }
    public SliceTerms Terms => _terms[^1];          // cadence, billing, period
    public IonTaskId? CurrentIonTask { get; }       // the landed open incarnation
    public IReadOnlyList<Stop> Stops => _stops;
    private readonly List<SliceTerms> _terms;
    private readonly List<Stop> _stops;
    private readonly List<Incarnation> _incarnations;

    // placement verbs — no terms version
    public StopId AddStop(Weekday d, TechId t, Instant at);
    public void ChangeTech(StopId s, TechId t, Instant at);
    public void ChangeDay(StopId s, Weekday d, Instant at);
    public void ChangeParity(DateOnly anchor, Instant at);   // validates: anchor on a stop
                                                             // weekday AND target parity
    // terms verbs — versions terms
    public void ChangeFrequency(Cadence c, Instant at);
    public void Reprice(Billing b, Instant at);

    // external identity — write-ahead
    public DeclarationId Declare(IncarnationIntent i, Instant at);
    public void Land(DeclarationId d, IonTaskId t, Instant at);   // predecessor closes HERE
    public void Abandon(DeclarationId d, string why, Instant at);

    public void Reflect(ObservedSlice o, Instant at);   // converge from ION
    public void End(DateOnly on, Instant at);
}

public sealed class Stop : Entity<StopId>
{
    public Weekday Weekday { get; private set; }
    public TechId TechId { get; private set; }
    internal void MoveTo(Weekday d);       // through the slice, so it can emit + enforce
    internal void AssignTo(TechId t);
}

public sealed class Incarnation : Entity<IncarnationId>
{
    public IonTaskId? IonTaskId { get; private set; }    // null until it lands
    public IncarnationIntent Intent { get; }
    public Instant DeclaredAt { get; }
    public Instant? LandedAt { get; private set; }
    public Instant? AbandonedAt { get; private set; }
    public string? AbandonReason { get; private set; }
    public bool IsPending => IonTaskId is null && AbandonedAt is null;
}

public sealed record SliceTerms(int Version, Cadence Cadence, Billing Billing,
                                Period Period, Instant From, TermsCause Cause);

public abstract record Cadence                     // PARITY LIVES HERE
{
    public sealed record Weekly(int TimesPerWeek)  : Cadence;
    public sealed record Biweekly(DateOnly Anchor) : Cadence;
    public sealed record Monthly(DateOnly Anchor)  : Cadence;
}

public sealed record Billing(string ServiceTypeId, int? PriceCents,
                             BillingType Type, IReadOnlyList<DayRate> DayRates);

/// WHY this work exists — what justifies a zero price, and what it repays.
/// (Replaces Basis, RULED 2026-08-09: `rider` dissolved into slices, and
/// `program` moved down to Serves. Nothing was left at agreement level.)
public sealed record Reason(ReasonKind Kind, SliceId? Compensates = null);
public enum ReasonKind { Contracted, QualityControl, TransitionBridge, Remediation }
```

### Basis is deleted (2026-08-09)

`Basis` carried `customer_contract | rider` plus a `program`. Under slices:

- **`rider` dissolves.** Work that exists because another agreement does is
  now a slice on that agreement, and the host cascade comes free — ending
  the agreement ends its slices. The cross-aggregate event handler that
  implemented "ending the host ends its riders" stops existing, and
  `classify-basis` dies with it.
- **`program` moves down** to `Serves.WorkType`, because it is decoded from
  service type and a customer may hold a maintenance slice and a
  green-to-clean slice at once.
- **What is left at agreement level is the relationship itself** — customer,
  lifecycle, and (when billing needs it) the invoicing policy. No `Basis`.
- **The one thing worth keeping is the "because"** — `Slice.Why`. A free
  slice with no recorded reason is an unexplained credit next month.

## Domain services

```csharp
public static class CadenceLaw
{
    public static GapBounds For(Cadence c);   // weekly [5,8] biweekly [10,14] monthly [24,32]
}

public sealed record SeamDecision(DateOnly Anchor, int GapDays,
                                  BridgeProposal? Bridge, IReadOnlyList<Violation> Violations);

public static class SeamPlanner
{
    // THE PARITY RULE: anchor first, gap second, bridge on the lost firing.
    public static SeamDecision ForParity(Slice s, WeekParity to, DateOnly? lastServed, DateOnly today);
    public static SeamDecision ForDayMove(Slice s, StopId stop, Weekday to, DateOnly? lastServed, DateOnly today);
}

public static class ArrangementDiff
{
    public static ChangeSet Between(Slice held, ObservedSlice observed);
}
```

## Ports

```csharp
public interface IAgreementRepository
{
    Task<Agreement?> ById(AgreementId id);
    Task<Agreement?> ByIonTask(IonTaskId id);
    Task<Agreement?> ByStop(StopId id);
    /// aggregate + facts + THE FLOOR PROJECTION, one transaction.
    Task Save(Agreement a);
}

public interface IIonTasks
{
    Task<ObservedSlice> Read(IonTaskId id);
    Task<IReadOnlyList<TaskSummary>> ListCustomerTasks(IonCustomerId c);
    /// returns only when READ-BACK confirms; otherwise throws.
    Task<Confirmation> ApplySupersession(SupersessionIntent i);
    Task<Confirmation> ApplyAmendment(AmendmentIntent i);
    Task<Confirmation> CreateOneTime(OneTimeIntent i);
    Task<Confirmation> Delete(IonTaskId id);
}

public interface IVisitHistory
{
    /// ACROSS THE LINEAGE — a superseded slice's history is its own.
    Task<DateOnly?> LastServed(Slice s);
}
```

## Use case 1 — ConvergeSlice (this is the cache staying in sync)

```csharp
public sealed class ConvergeSlice(IAgreementRepository repo, IIonTasks ion, IObservationLog log)
{
    public async Task<ConvergeResult> Run(SliceRef r, Instant at)
    {
        var agreement = await repo.ById(r.AgreementId) ?? throw new AgreementNotFound(r);
        var slice = agreement.SliceOf(r.SliceId);
        if (slice.CurrentIonTask is not { } taskId)
            return ConvergeResult.PendingDeclaration;      // a write is in flight; do not guess

        var observed = await ion.Read(taskId);
        await log.Record(taskId, at, observed);            // evidence, never authority

        if (ArrangementDiff.Between(slice, observed).IsEmpty)
            return ConvergeResult.Unchanged;               // level-triggered: silence on agreement

        slice.Reflect(observed, at);                       // versions terms / moves stops / ends
        await repo.Save(agreement);                        // <- the floor follows, same transaction
        return ConvergeResult.Converged;
    }
}
```

The cache cannot drift because there is no `Save` that writes the aggregate
without the projection, and no code path that writes the projection alone.

## Use case 2 — ChangeTech

```csharp
public sealed class ChangeTech(IAgreementRepository repo, IIonTasks ion)
{
    public async Task<ChangeResult> Run(StopId stopId, TechId toTech, Instant at)
    {
        var agreement = await repo.ByStop(stopId) ?? throw new StopNotFound(stopId);
        var slice = agreement.SliceOfStop(stopId);

        // 1. converge ION drift FIRST — never write on top of an edit we have not seen
        slice.Reflect(await ion.Read(slice.CurrentIonTask!), at);
        if (slice.Status is SliceStatus.Ended) return ChangeResult.Refused("ION ended this slice");

        // 2. our change — names its subject, so a stale picture FAILS rather than moving
        //    the wrong pool
        slice.ChangeTech(stopId, toTech, at);

        // 3. declare BEFORE touching ION
        var decl = slice.Declare(IncarnationIntent.From(slice), at);
        await repo.Save(agreement);

        // 4. write, confirmed by read-back inside the port
        try
        {
            var c = await ion.ApplySupersession(SupersessionIntent.From(slice, decl));
            slice.Land(decl, c.NewIonTaskId, at);          // predecessor closes here
        }
        catch (IonWriteFailed e)
        {
            slice.Abandon(decl, e.Message, at);            // no pending intent left dangling
            await repo.Save(agreement);
            throw;
        }
        await repo.Save(agreement);                        // floor follows
        return ChangeResult.Landed(slice.CurrentIonTask!);
    }
}
```

## Use case 3 — ChangeParity (the one that exposed the old model)

```csharp
public sealed class ChangeParity(IAgreementRepository repo, IIonTasks ion, IVisitHistory visits)
{
    /// what the dialog shows BEFORE anything writes
    public async Task<SeamDecision> Preview(SliceRef r, WeekParity to, DateOnly today)
    {
        var slice = (await repo.ById(r.AgreementId))!.SliceOf(r.SliceId);
        return SeamPlanner.ForParity(slice, to, await visits.LastServed(slice), today);
    }

    public async Task<ChangeResult> Run(SliceRef r, WeekParity to, BridgeRuling ruling, Instant at)
    {
        var agreement = (await repo.ById(r.AgreementId))!;
        var slice = agreement.SliceOf(r.SliceId);

        slice.Reflect(await ion.Read(slice.CurrentIonTask!), at);

        var lastServed = await visits.LastServed(slice);           // across the lineage
        var seam = SeamPlanner.ForParity(slice, to, lastServed, at.Date);
        if (seam.Violations.Count > 0 && !ruling.Accepted)
            return ChangeResult.Refused(seam);                     // the operator rules first

        slice.ChangeParity(seam.Anchor, at);                       // "week B -> week A" == a new anchor
        var decl = slice.Declare(IncarnationIntent.From(slice), at);

        // the accepted bridge is a ONE-TIME SLICE — its own thing, its own ION task
        SliceId? bridge = ruling.Accepted
            ? agreement.AddSlice(slice.Serves, SliceKind.OneTime,
                                 SliceTerms.FreeOneTime(ruling.Date),
                                 new Reason(ReasonKind.TransitionBridge, slice.Id), at)
            : null;

        await repo.Save(agreement);                                // both declarations recorded

        var c = await ion.ApplySupersession(SupersessionIntent.From(slice, decl));
        slice.Land(decl, c.NewIonTaskId, at);

        if (bridge is { } b)                                       // SECOND ION write
        {
            var bs = agreement.SliceOf(b);
            var bd = bs.Declare(IncarnationIntent.From(bs), at);
            var bc = await ion.CreateOneTime(OneTimeIntent.From(bs, bd));
            bs.Land(bd, bc.NewIonTaskId, at);
        }

        await repo.Save(agreement);
        return ChangeResult.Landed(slice.CurrentIonTask!);
    }
}
```

## What writing these exposed

1. **One change can require more than one ION write.** An accepted bridge is a
   second slice with its own declaration, its own create, its own landing. The
   old pipeline treated a bridge as a footnote on a move (`bridge_needs_probe`)
   and it never got written. Model it as a slice and it cannot be forgotten.

2. **`Preview` and `Run` are the same rule called twice.** The dialog needs the
   seam before writing; the run needs it again at execution. Same
   `SeamPlanner.ForParity` — never a second implementation. (The old preview and
   publish used different code, which is how a stale scenario got through.)

3. **`Reflect` can end a slice mid-use-case.** If ION says the task expired
   while we were deciding, the change must refuse — so every write use case
   needs the guard after `Reflect`, not just at the start.

4. **`ChangeParity` never asks for a date.** Landing on the target fortnight IS
   the change; the anchor is computed and the only choice is the seam. That is
   why the old desired-state diff could produce nothing at all.

5. **Two `Save` calls per write use case, and that is correct** — one for the
   declaration (before ION), one for the landing (after). An unrecorded
   supersession is unrepresentable because the first save happens before the
   write.

## Open questions

- **Does a customer ever hold two CONCURRENT agreements?** With the fountain
  and riders both slices, no case is left except a second property or a
  different billing entity. If none, `one active agreement per customer`
  becomes an enforceable invariant and the duplicate-claim class dies.
- Does `AddStop` on a Recurring slice imply a frequency change, or can coverage
  legitimately lag the pattern? (Affects whether `AddStop` versions terms.)
- Where does `Reflect` put a covers/serves change — is a work-type change a new
  slice or a redefinition of this one?
- One-time slices and `ActiveAgreement`: a `OneTime` slice ending must not end
  the agreement.
