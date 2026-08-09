/**
 * Surgical EndsOn retry for the boundary test — ONE update op, ISO date
 * (the form's EndsOn is a native date input; MM/DD appears to be silently
 * dropped on the edit path). Dry by default; --live to arm.
 *   npx tsx scripts/routing/retry-endson.ts <ionTaskId> <ionCustId> <YYYY-MM-DD> [--live]
 */
const API = process.env.WINDMILL_BASE_URL!.replace(/\/$/, "") + "/w/jps-internal"
const AUTH = { Authorization: `Bearer ${process.env.WINDMILL_TOKEN}`, "Content-Type": "application/json" }
async function main() {
  const [taskId, custId, endsOn] = process.argv.slice(2)
  const live = process.argv.includes("--live")
  if (!taskId || !custId || !/^\d{4}-\d{2}-\d{2}$/.test(endsOn ?? "")) throw new Error("usage: retry-endson.ts <task> <cust> <YYYY-MM-DD> [--live]")
  const r = await fetch(`${API}/jobs/run/p/f/ION/api/write_task`, {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ op: "update", ionTaskId: taskId, ionCustId: custId, changes: { EndsOn: endsOn }, dry_run: !live }),
  })
  const job = (await r.text()).replace(/"/g, "")
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 4000))
    const d = await (await fetch(`${API}/jobs_u/completed/get_result_maybe/${job}`, { headers: AUTH })).json()
    if (d.completed) { console.log(JSON.stringify(d.result, null, 1).slice(0, 2500)); return }
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
