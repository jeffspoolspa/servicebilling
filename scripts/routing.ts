/**
 * The routing use cases, from a terminal.
 *
 *   npx tsx scripts/routing.ts plan  <scenarioId>   what publishing would do
 *   npx tsx scripts/routing.ts push  <scenarioId>   queue it — what the button does
 *   npx tsx scripts/routing.ts drain [--all]        work the queue, one unit per call
 *   npx tsx scripts/routing.ts watch [seconds]      follow the rows until they settle
 *
 * A THIN CLIENT over the same endpoints the browser calls. It holds no
 * composition and no rules: the endpoints are the presentation layer, and a
 * terminal is just another caller of them. Anything this file decided would be
 * a rule the button does not have.
 *
 * ROUTING_URL   where to call (default http://localhost:3000)
 * OPERATOR_TOKEN  bearer token; the same value the endpoints check
 */
import { readFileSync } from "node:fs"
for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const a = l.indexOf("=")
  if (a > 0 && !l.startsWith("#")) process.env[l.slice(0, a).trim()] ??= l.slice(a + 1).trim()
}

const BASE = (process.env.ROUTING_URL ?? "http://localhost:3000").replace(/\/$/, "")
const TOKEN = process.env.OPERATOR_TOKEN ?? process.env.CRON_SECRET
if (!TOKEN) throw new Error("set OPERATOR_TOKEN (or CRON_SECRET) — the endpoints authenticate the terminal the same way they authenticate the browser")

async function call<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  })
  const body = (await r.json().catch(() => ({}))) as T
  return { status: r.status, body }
}

type QRow = {
  id: string; task_id: string; state: string; attempts: number; error: string | null
  ion_task_id: string | null; result_ion_task_id: string | null; result_task_id: string | null
}

const MARK: Record<string, string> = { done: "OK ", dead_letter: "DEAD", in_flight: "..>", queued: " . " }

function render(rows: QRow[]): string {
  if (rows.length === 0) return "  (none)"
  return rows.map((r) =>
    `  ${(MARK[r.state] ?? r.state).padEnd(4)} ${r.task_id.slice(0, 8)}  ` +
    `${(r.ion_task_id ?? "-").padEnd(9)}-> ${(r.result_ion_task_id ?? "").padEnd(9)}` +
    `${r.result_task_id ? "cached" : "      "}  ${r.attempts}x  ${r.error ? r.error.slice(0, 70) : ""}`,
  ).join("\n")
}

/** The row the pill tracks — read straight from the published view. */
async function rowsFor(ids?: string[]): Promise<QRow[]> {
  const q = ids?.length ? `?ids=${ids.join(",")}` : "?open=1"
  const { status, body } = await call<{ rows?: QRow[]; error?: string }>(`/api/routing/schedule-changes${q}`)
  if (status !== 200) throw new Error(body.error ?? `status ${status}`)
  return body.rows ?? []
}

async function main() {
  const [cmd, arg] = process.argv.slice(2)

  if (cmd === "plan" || cmd === "push") {
    if (!arg) throw new Error("give a scenario id")
    const { status, body } = await call<Record<string, unknown>>(
      `/api/routing/scenarios/${arg}/publish`,
      { method: "POST", body: JSON.stringify({ dry_run: cmd === "plan" }) },
    )
    if (status >= 400) throw new Error(String(body.error ?? status))
    if (cmd === "plan") {
      const out = body as unknown as { results: { accepted: boolean; quotaId: string; detail: string }[]; invalidated: { reason: string }[] }
      console.log(`\nDRY RUN of ${arg}\n`)
      for (const r of out.results ?? []) console.log(`  ${r.accepted ? "OK " : "NO "} ${r.quotaId.slice(0, 8)}  ${r.detail}`)
      for (const i of out.invalidated ?? []) console.log(`  DROP ${i.reason}`)
      return
    }
    const queued = (body as unknown as { queued: { queueId: string }[] }).queued ?? []
    console.log(`queued ${queued.length} change(s)`)
    console.log(render(await rowsFor(queued.map((q) => q.queueId))))
    return
  }

  if (cmd === "drain") {
    const all = process.argv.includes("--all")
    for (;;) {
      const { status, body } = await call<{ drained?: number; detail?: string; error?: string; taskId?: string; ionTaskId?: string | null }>(
        "/api/routing/schedule-changes/drain", { method: "POST" },
      )
      if (status >= 400) throw new Error(String(body.error ?? status))
      if (!body.drained) { console.log(`  ${body.detail ?? body.error ?? "nothing to do"}`); break }
      console.log(`  OK  ${body.taskId?.slice(0, 8)}  ${body.detail}${body.ionTaskId ? ` (ION ${body.ionTaskId})` : ""}`)
      if (!all) break
    }
    console.log("\nopen rows:")
    console.log(render(await rowsFor()))
    return
  }

  if (cmd === "watch") {
    const deadline = Date.now() + Number(arg ?? 600) * 1000
    for (;;) {
      const rows = await rowsFor()
      console.log(`\n[${new Date().toISOString().slice(11, 19)}] open: ${rows.length}`)
      console.log(render(rows))
      if (rows.length === 0) { console.log("\nqueue settled"); return }
      if (Date.now() > deadline) { console.log("\nstopped watching — the work continues server side"); return }
      await new Promise((r) => setTimeout(r, 5000))
    }
  }

  console.log(readFileSync("scripts/routing.ts", "utf8").split("*/")[0].split("\n").slice(1, 12).map((l) => l.replace(/^ \* ?/, "")).join("\n"))
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
