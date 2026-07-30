# Runbook — retiring a script

> Status: [active] 2026-07-20. How we take a script out of service without
> losing it, and without breaking a live workflow. Pairs with the
> [workflow-map](../reference/workflow-map.md) (what's active) and
> [COMPUTE_GOVERNANCE](../conventions/COMPUTE_GOVERNANCE.md) (why idle ≠ dead).

Retirement is a **lifecycle move**, not a delete: an old script stays readable
as the reference for how that method/architecture worked, but moves out of the
active set so `active` folders can be trusted at a glance. Deletion is a
separate, later decision.

## The one rule: idle is a flag, never a trigger

"Hasn't run in a month" does NOT mean dead. A script can be idle because it's a
library imported in-process, a monthly job, a rare webhook, an app-route target,
or a brand-new primitive nothing has adopted yet. **Clear all five guards before
retiring anything.**

## Step 1 — clear the five guards

A script is a retire candidate only if ALL are false:

| Guard | How to check | Idle-but-KEEP if... |
|---|---|---|
| Imported | `grep -rlF -e "f/area/name" -e "f.area.name" f u lib app` | any active file imports/calls it |
| Scheduled | search `listSchedules` for the path | it has a schedule (even monthly) |
| Triggered | check DB wake triggers + `billing.wake_policy`; Windmill HTTP/webhook routes | a trigger/webhook targets it |
| App-route reachable | `grep -rl "f/area/name" app/api app` | a live UI route calls it |
| Canonical primitive | is it the *intended* shared target (e.g. `f/qbo/get_access_token`)? | it's a migration target not yet adopted |

Cross-check against the [workflow-map](../reference/workflow-map.md): a script
mapped to a `[dead]` role with no active caller is a true candidate; anything
`[v1-retiring]` retires only *after* its cutover (below).

## Step 2 — if it's `[v1-retiring]`, cut over first

A superseded-but-still-wired script (old system reachable from a live route/flow)
is retired by **completing its cutover**, not by archiving it under a live caller:

1. Repoint the app route / flow / trigger to the replacement (the new sentence).
2. Verify the new path end-to-end (watch the ledger — the old script's
   `Seats/mo` should drop to ~0, the new one absorbs it).
3. Only then does the old script become a true `[dead]` candidate.

## Step 3 — move to `f/z_retired/`

Windmill is the source of truth (the repo is synced *from* it via
`sync-script-to-git-repo-windmill`), so the move happens in **Windmill**, and the
sync mirrors it to the repo. Convention: `f/z_retired/<origin-area>/<name>`
(e.g. `f/z_retired/maintenance_v1/send_monthly_invoices`), preserving provenance.
Turn off any schedule/trigger first (delete the schedule; remove or disable the
`wake_policy` row). Move the whole superseded cluster together so it stays a
coherent, readable v1 reference.

Bulk sets not touching live routes (dev probes: `_discover/*`, `_run/*`,
`test_/explore_`) can move in one pass. Non-project scripts not mirrored in the
repo get individual review.

## Step 4 — update the docs in the SAME change

Docs and reality must not drift:

- **workflow-map** — move the script's row to the retired workflow / drop it
  from the active index.
- **SYSTEM_MAP** — if it named the script, update it.
- **flow docs** (`docs/flows/<x>`) — mark the retired path `[drift]`→removed and
  point at the replacement.
- **The migration/PR** that does the cutover carries all of the above.

## Step 5 — later: delete review

`f/z_retired/` is the holding area. A periodic pass decides what is truly
delete-worthy (superseded methods we'll never reference again) vs. worth keeping
as reference. Deletion is deliberate and separate — never automatic.

## Worked example — QBO cache sync slice

- `process_maint_period` — `[dead]`: the `process` route already calls
  `process_maint_charges`, nothing else references it → true candidate, retire now.
- `send_monthly_invoices` + `stamp_invoke_memos` + the autopay flow —
  `[v1-retiring]`: still reached by the Send route / `monthly_autopay.flow` →
  retire *after* the Send-path cutover (Step 2).
- `f/qbo/get_access_token` — idle but a **canonical primitive** (the intended
  shared token source scripts should adopt) → NOT retired; it's a migration
  target. Do NOT archive.
