# Routing changes — the rules, stated

> Status: [active] — the spec the rebuild starts from (2026-08-09).
> Written before implementation on purpose: every rule below was derivable
> from the old code only by reading it, and twice it turned out the code
> did something other than what it meant.

## The model these rules assume

```
Agreement          one customer, one program, one basis. The invoicing unit.
└─ Slice[]         ONE serviced thing (the pool; the fountain; chem testing)
   ├─ covers       what it is (stop type, profile/body)
   ├─ terms        cadence + times per week + PARITY ANCHOR, price, period
   ├─ kind         recurring | one_time — read by the routing planner
   │               (route load, coverage) and by billing (price, invoice)
   ├─ incarnations ION task ids over time: declared -> landed | abandoned
   └─ Stop[]       (id, weekday, techId) — where it lands in the week
```

A change NAMES its subject and is a verb against it. It is never a new
desired state diffed against a picture that may be stale: an intent that
names its stop either applies or fails loudly, where a diff computed from
a stale picture writes confidently and wrongly (the wrong-tech publish,
2026-08-09) or silently does nothing (Marie Malone's parity flip, the
same day).

| verb | owner | changes terms? |
|---|---|---|
| `changeTech(stopId, techId)` | Stop | no |
| `changeDay(stopId, weekday)` | Stop | no |
| `changeParity(sliceId, toWeek, seam)` | Slice | no |
| `changeFrequency(sliceId, cadence)` | Slice | YES — versioned |
| `addStop` / `removeStop(sliceId, ...)` | Slice | only via frequency |

Parity and frequency belong to the SLICE because a fortnight and a
cadence are properties of a serviced thing, not of a Tuesday. Two slices
on one agreement may sit on different fortnights.

## Parity change — the rule

Carter's statement, which is the rule verbatim:

> Biweekly B to A. She is on Friday. The current period ends today, so
> find the first FUTURE Friday on week A — the 21st. StartsOn is the
> 21st. That is 20 days since her last visit, over the 14-day maximum,
> so flag it and default a bridge visit to the 14th (the firing she
> loses). The operator can move the bridge to tomorrow. Then write.

Stated as steps, in this order and no other:

1. **The anchor is chosen first.** The first date that is (a) in the
   future, (b) after the current period ends, (c) on one of the slice's
   stop weekdays, and (d) on the target fortnight. Landing on the target
   fortnight IS the change — the date is not a free variable to be
   traded away for a comfortable gap.
2. **The gap is computed second, and only reported.** Days from the last
   completed visit to the new anchor, against the cadence bounds
   (biweekly [10,14], weekly [5,8], monthly [24,32]).
3. **An over-gap defaults to a bridge on the firing that is lost** — the
   date the old parity would have served. Not a midpoint, not a search
   result: the visit she does not get is the visit we give back. That is
   what makes the default meaningful and moving it a deliberate override.
4. **An under-gap (shifting earlier) cannot be bridged.** You cannot
   un-serve a pool; serving early is a cost decision, and it is the
   operator's to make, not the planner's.
5. **The operator rules on the seam before anything writes** — accept the
   bridge, move its date, or decline it.

Consequences that are not optional:

- A parity change is a PLACEMENT change: no terms version. Nothing
  commercial moved.
- ION can express it only through `StartsOn`, the same field that
  reclassifies completed visits, so a parity change is ALWAYS a
  supersession. In-place StartsOn edits are vetoed (2026-08-09).
- Only interval cadences have parity. A weekly slice cannot flip.
- **There is no free parity flip.** Every one opens a seam, so every one
  surfaces a ruling. A parity change that reports no gap decision has
  lost information.

## Last served — whose history?

The last completed visit of the AGREEMENT'S LINEAGE, never of the current
ION task. A pool superseded last week has zero visits on its new task;
reading per-task makes every successor this pipeline creates look
never-served, and the gap law then has no history to protect. That defect
silently disabled gap protection for exactly the pools we had just moved
(2026-08-09).

## What every change owes the operator

Before the write: the subject, the shape of the write, the first service
date, and any seam ruling — in front of a person, with a stale scenario
refusing HERE rather than halfway through ION.

During: each declared step crossing off, per change.

After: `done` only when the published placement matches the target. A
change that renders no ION operation is not a success — on a first pass
it means the intent did not survive translation.

## See also

- [EVENT_VOCABULARY.md](../conventions/EVENT_VOCABULARY.md) — the closed
  list of facts a change can emit, and the write-ahead declaration rule.
