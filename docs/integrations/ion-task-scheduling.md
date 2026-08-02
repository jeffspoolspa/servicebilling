# ION task scheduling — how a task's day is actually set

> Status: [active]
> Confirmed with Carter and against live ION forms, 2026-08-02. This governs
> every write to a recurring task's schedule. Read it before touching
> `f/ION/api/update_task`, `f/ION/api/create_task`, or the routing publisher.

## The rule

**How ION stores a task's serviced day depends on its cadence.**

| Cadence | Where the day lives | How to move it |
|---|---|---|
| **Weekly** | the day picker — `day1`..`day7`, one tech `<select>` per weekday, Sun..Sat, empty = not serviced | write the day fields |
| **Bi-weekly** | **`StartsOn`** — the start date's weekday IS the serviced day | change `StartsOn` |
| **Monthly** | `StartsOn`, same as bi-weekly | change `StartsOn` |

For bi-weekly, `StartsOn` does double duty: its weekday sets the day, and **the
week it falls in sets the A/B grouping** (which of the alternating weeks the
task takes). So sliding a bi-weekly task from the A week to the B week means
moving `StartsOn` by one week — not touching any day field.

This is the same fact the routing domain already models as `anchorWeek`:
`cadenceLabel` reports `biweekly A` / `biweekly B` from anchor-week parity, and
`Quota.shiftAnchor()` slides between them. ION implements that concept as
`StartsOn`.

## Why this matters — the failure it causes

A non-weekly task renders **without the day picker**. Two consequences:

1. **Reads.** `parseTaskForm` returns `perDayTech: []` for these tasks, which
   looks identical to "this task has no days assigned". It is not. The tell is
   `fields` being empty — a form that did not render its inputs. Any reconcile
   that treats an empty `perDayTech` as authoritative will deactivate real
   slots. This nearly wiped ~30 customers' schedules from our cache on
   2026-08-02; caught because one was re-read and `fields parsed: 0`.

   **Rule: an empty `perDayTech` with zero parsed `fields` is a FAILED READ, not
   an empty schedule.**

2. **Writes.** Writing `day1..day7` at a bi-weekly task cannot move it — the day
   is not stored there. `IonRoutePublisher` therefore refuses any task whose
   `maintenance.tasks.frequency` is not `weekly`, rather than issuing a write
   that silently does nothing (or worse). Moving a non-weekly task needs a
   `StartsOn` write, which is **not implemented**.

## Consequences for routing publish

- Weekly tasks publish normally (complete-week write, guarded by `expect_days`).
- Bi-weekly and monthly tasks are **refused with a reason**, not skipped.
- A scenario that moves non-weekly stops cannot be fully published yet. Building
  that means teaching the publisher to express a day/parity change as a
  `StartsOn` date, and deciding what start date is legitimate for a contract
  that has been running for months (moving `StartsOn` backwards rewrites
  history; forwards may skip a visit).

## Related

- [WINDMILL_DEPLOY.md](../conventions/WINDMILL_DEPLOY.md) — how to deploy these scripts
- `f/ION/_lib/task_detail.ts` — `parseTaskForm`, `updateTask`
- `f/ION/_lib/upsert_schedules.py` — the inbound sync; retires days ION dropped
