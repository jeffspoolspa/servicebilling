//bun-extra-requirements:
//playwright@1.40.0

// ION API endpoint: active recurring tasks.
//
// Single composition point: takes filter args -> gets/refreshes the background session
// -> primes (once) + fetches + normalizes -> structured rows. Each step is a swappable
// imported function: change the normalizer (in _lib/reports) and this same endpoint
// returns the new shape. chromium-tagged so it CAN log in, but only launches the browser
// when the cached session is stale; otherwise it's pure HTTP.
//
// Returns count + sample (full set ~487 rows). Bulk consumers import getRecurringTasks
// from /f/ION/_lib/reports and process in-process.

import "playwright@1.40.0"
import * as wmill from "windmill-client"
import { getOrRefreshSession } from "/f/ION/_lib/session_cache"
import { getRecurringTasks } from "/f/ION/_lib/reports"

export async function main(filters: Record<string, string | number> = {}) {
  const ion = {
    loginUrl: await wmill.getVariable("f/ION/LOGIN_URL"),
    username: await wmill.getVariable("f/ION/USERNAME"),
    password: await wmill.getVariable("f/ION/PASSWORD"),
  }
  const session = await getOrRefreshSession(ion)        // reuse cached session, or login if stale
  const tasks = await getRecurringTasks(session, filters) // prime (once) + fetch + normalize
  return { count: tasks.length, sample: tasks.slice(0, 2) }
}
