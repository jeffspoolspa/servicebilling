# Windmill deploy — use the REST API, not the MCP

> Status: [active]
> The Windmill **MCP connector is scoped to the wrong principal**: an unfiltered
> `listScripts` returns only `u/rdoyle/gbp/*` scripts (Ryan's Google Business
> Profile work), never `f/billing/*`. So from the MCP, reads of billing paths
> return `[]` and `createScript` under `f/` fails the `script`-table
> row-level-security policy — it simply can't see or write the billing scope.
> Deploy, read, and run through the **REST API** instead, using the app token in
> `.env.local` (broad `jps-internal` + `f/` access) with an explicit
> `/w/jps-internal/` URL. Verified end-to-end 2026-07-10 (deployed
> `f/billing/_lib/db`, ran an import smoke test, got a result, deleted it).

If the MCP `listScripts` returns `u/rdoyle/*` (or empty for `f/billing/*`), it's
the wrong-scope connector — don't debug it, use the REST API below. (Permanent
fix if wanted: repoint the MCP connector at the `jps-internal` workspace with a
token that has `f/` access.)

## Setup (one block)

```bash
set -a; source .env.local; set +a        # WINDMILL_TOKEN / _BASE_URL / _WORKSPACE
API="${WINDMILL_BASE_URL%/}"             # https://app.windmill.dev/api
WS="$WINDMILL_WORKSPACE"                  # jps-internal
AUTH="Authorization: Bearer $WINDMILL_TOKEN"
```

The app token is a 32-char token that can **read, create, and run**. (The MCP
token cannot — empty reads, RLS on create. That is the whole reason for this doc.)

## Read a script (also: get the current hash for an update)

```bash
curl -s -H "$AUTH" "$API/w/$WS/scripts/get/p/f/billing/process_maint_period"
```

## Deploy a NEW script

JSON-encode the file content with `jq --rawfile` — never hand-escape multiline code:

```bash
jq -n --rawfile c f/billing/_lib/db.py \
  '{path:"f/billing/_lib/db", summary:"...", description:"...",
    content:$c, language:"python3", kind:"script"}' > body.json
curl -s -w "\nHTTP %{http_code}\n" -X POST -H "$AUTH" -H "Content-Type: application/json" \
  --data @body.json "$API/w/$WS/scripts/create"          # -> new hash, HTTP 201
```

## UPDATE an existing script (version in place, keep history)

Add `parent_hash` = the current hash from the read above:

```bash
jq -n --rawfile c file.py --arg ph "<current_hash>" \
  '{path:"<path>", summary:"...", description:"...", content:$c,
    language:"python3", kind:"script", parent_hash:$ph}' > body.json
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  --data @body.json "$API/w/$WS/scripts/create"
```

Without `parent_hash` on a live path you get `Path conflict ... non-archived hash`.

## Run

- **Sync** (fast DB / `dry_run` scripts): `POST .../jobs/run_wait_result/p/<path>`
  with body `{}` → returns the result JSON directly.
- **Async** (slow / chromium): `POST .../jobs/run/p/<path>` → job uuid; poll
  `GET .../jobs/get/<uuid>` (the `result` field carries the return value).
- `run` passes **no args** (uses defaults). For non-default args, bake a one-shot
  wrapper script or use `run_wait_result` with an args body.

```bash
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" --data '{}' \
  "$API/w/$WS/jobs/run_wait_result/p/f/billing/_smoke_lib_import"
```

## Delete

```bash
curl -s -X POST -H "$AUTH" "$API/w/$WS/scripts/delete/p/<path>"
```

## Footguns (carried from prior sessions)

- **`create` silently drops the worker `tag`.** For ION/chromium scripts you MUST
  include `"tag":"chromium"` in the body, or the redeploy runs tag-null on a
  heterogeneous pool and fails intermittently (`chromium ... doesn't exist`).
  Read the current tag first. Python DB scripts use tag null.
- **Relock children:** after a deploy a dependency relock can create a CHILD
  version, so a follow-up `parent_hash` update may fail `lineage must be linear`
  and return the child hash — re-fetch the head and use that as `parent_hash`.
- **Do NOT** copy files into `/Users/cartergasia/windmill` and `wmill sync push` —
  Carter manages that workspace himself.

Repo `f/<folder>/<name>.py` maps 1:1 to Windmill `f/<folder>/<name>`.

## See also

- [ADR 009](../adrs/009-shared-qbo-primitives-lib.md) — the shared-`_lib`
  extraction this deploy path unblocks.
- The `feedback-windmill-script-update` agent memory — same content, agent-facing.
