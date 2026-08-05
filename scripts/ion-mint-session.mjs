// ion-mint-session — mint a fresh ION session in a REAL browser environment
// (GitHub Actions Ubuntu, where playwright chromium just works) and push it
// into Windmill's f/ION/session_cache variable. The ingest then runs
// browser-free on Windmill. This routes the ONE browser-dependent step
// (login) off Windmill's broken chromium worker onto infra we control.
//
// Env (GitHub Actions secrets):
//   WINDMILL_TOKEN      — Windmill API token (scope: write the session_cache var)
//   WINDMILL_WORKSPACE  — default "jps-internal"
//   WINDMILL_BASE       — default "https://app.windmill.dev/api"
//   TRIGGER_INGEST      — "1" to also kick daily_visit_ingest after minting
//
// ION creds are read from Windmill (single source of truth) — GH only needs
// the Windmill token.
import { chromium } from "playwright"

const BASE = process.env.WINDMILL_BASE || "https://app.windmill.dev/api"
const WS = process.env.WINDMILL_WORKSPACE || "jps-internal"
const TOKEN = process.env.WINDMILL_TOKEN
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
const INACTIVITY_MS = 2 * 60 * 60 * 1000 // 2h — keepalive extends further

if (!TOKEN) { console.error("WINDMILL_TOKEN missing"); process.exit(2) }

async function wmGetVar(path) {
  const r = await fetch(`${BASE}/w/${WS}/variables/get_value/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  if (!r.ok) throw new Error(`get_value ${path}: ${r.status}`)
  return r.json()
}

async function wmSetVar(path, value) {
  const r = await fetch(`${BASE}/w/${WS}/variables/update/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  })
  if (!r.ok) throw new Error(`update ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`)
}

async function wmRunScript(path, args) {
  const r = await fetch(`${BASE}/w/${WS}/jobs/run/p/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  if (!r.ok) throw new Error(`run ${path}: ${r.status}`)
  return (await r.text()).replace(/"/g, "")
}

// ION retired the Fluidra portal hop (2026-08): login is now a single ColdFusion
// form on ionpoolcare.com. f/ION/LOGIN_URL still holds the dead Fluidra URL and is
// deliberately no longer read -- one less var to keep in sync with the vendor.
// Mirrors ION_LOGIN_URL in f/ION/_lib/session; that lib can't be imported here
// (different runtime), which is why this login exists twice and only twice.
const ION_LOGIN_URL = "https://ionpoolcare.com/security/login.cfm"

const [username, password] = await Promise.all([
  wmGetVar("f/ION/USERNAME"),
  wmGetVar("f/ION/PASSWORD"),
])

const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ userAgent: UA })
  const page = await context.newPage()
  let cfClientId
  page.on("request", (req) => {
    if (cfClientId) return
    const m = req.url().match(/_cf_clientid=([A-F0-9]{32})/i)
    if (m) cfClientId = m[1]
  })
  await page.goto(ION_LOGIN_URL, { waitUntil: "load", timeout: 60000 })
  await page.locator("#IPCLogin").fill(username)
  await page.locator("#IPCPassword").fill(password)
  await page.locator("#Submitted").click() // <input type=submit>, not a <button>
  await page.waitForLoadState("networkidle", { timeout: 45000 })

  // main.cfm is what fires the ux_*.cfm AJAX carrying _cf_clientid, so go there
  // explicitly rather than trusting wherever the login POST happens to land.
  const ionOrigin = new URL(page.url()).origin
  await page.goto(`${ionOrigin}/main.cfm`, { waitUntil: "load", timeout: 60000 })
  await page.waitForLoadState("networkidle", { timeout: 60000 })

  // A bad password ALSO leaves us on ionpoolcare.com now that login is single-stage,
  // so the origin proves nothing on its own: ION bounces an unauthed /main.cfm back
  // to the login form. Without this check a rejected login would be cached as a
  // valid session and every downstream ingest would 302 to login instead.
  if (!ionOrigin.includes("ionpoolcare.com")) {
    console.error("login did not land on ionpoolcare.com:", page.url())
    process.exit(3)
  }
  if (await page.locator("#IPCLogin").count()) {
    console.error("ION rejected the login — still on the login form:", page.url())
    process.exit(3)
  }
  const raw = await context.cookies()
  const cookies = raw.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
  }))
  const now = Date.now()
  const session = { cookies, cfClientId, ionOrigin, capturedAt: now, expiresAt: now + INACTIVITY_MS }
  await wmSetVar("f/ION/session_cache", JSON.stringify(session))
  console.log(`minted + pushed: ${cookies.length} cookies, cfClientId ${cfClientId ? "yes" : "no"}`)

  if (process.env.TRIGGER_INGEST === "1") {
    const job = await wmRunScript("f/ION/daily_visit_ingest", { lookback_days: 2, dry_run: false })
    console.log(`triggered daily_visit_ingest: job ${job}`)
  }
} finally {
  await browser.close()
}
