/**
 * Windmill API client for triggering scripts from Next.js route handlers.
 */

const WINDMILL_BASE = process.env.WINDMILL_BASE_URL || "https://app.windmill.dev/api"
const WINDMILL_WORKSPACE = process.env.WINDMILL_WORKSPACE || "jps-internal"
const WINDMILL_TOKEN = process.env.WINDMILL_TOKEN

async function runAtPath(
  kind: "p" | "f",
  path: string,
  args: Record<string, unknown>,
): Promise<{ jobId: string }> {
  if (!WINDMILL_TOKEN) {
    throw new Error(
      "WINDMILL_TOKEN env var is missing. Add it to .env.local (and Vercel for prod) — see .env.example. Get a token from Windmill Settings → Tokens.",
    )
  }

  const resp = await fetch(
    `${WINDMILL_BASE}/w/${WINDMILL_WORKSPACE}/jobs/run/${kind}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WINDMILL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    },
  )

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Windmill ${resp.status}: ${text.slice(0, 200)}`)
  }

  const jobId = await resp.text()
  return { jobId: jobId.replace(/"/g, "") }
}

/** Trigger a Windmill script (not a flow). */
export async function triggerScript(
  scriptPath: string,
  args: Record<string, unknown> = {},
): Promise<{ jobId: string }> {
  return runAtPath("p", scriptPath, args)
}

/**
 * Trigger a Windmill script AND wait for the result synchronously. Uses
 * Windmill's `/run_wait_result/` endpoint so we get the script's return
 * value in one HTTP round-trip.
 *
 * Use this for user-facing mutations where the UI needs an authoritative
 * outcome (e.g., "did QBO accept this credit application?"). The async
 * triggerScript() + poll pattern is wrong for these — it can return before
 * the downstream API has actually acknowledged, leading to false-positive
 * UI animations.
 *
 * Throws on non-2xx (including job failure). The result is the script's
 * return value (usually a dict).
 */
export async function triggerScriptSync<T = unknown>(
  scriptPath: string,
  args: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  if (!WINDMILL_TOKEN) {
    throw new Error("WINDMILL_TOKEN env var is missing")
  }

  const timeoutMs = opts.timeoutMs ?? 60000
  // Windmill's run_wait_result endpoint accepts a timeout query param (seconds)
  const timeoutS = Math.ceil(timeoutMs / 1000)

  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs + 5000)

  try {
    const resp = await fetch(
      `${WINDMILL_BASE}/w/${WINDMILL_WORKSPACE}/jobs/run_wait_result/p/${scriptPath}?timeout=${timeoutS}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WINDMILL_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      },
    )

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Windmill ${resp.status}: ${text.slice(0, 300)}`)
    }

    return (await resp.json()) as T
  } finally {
    clearTimeout(abortTimer)
  }
}

/** Trigger a Windmill flow. */
export async function triggerFlow(
  flowPath: string,
  args: Record<string, unknown> = {},
): Promise<{ jobId: string }> {
  return runAtPath("f", flowPath, args)
}

export async function getJobStatus(jobId: string): Promise<{
  running: boolean
  success?: boolean
  result?: unknown
}> {
  if (!WINDMILL_TOKEN) throw new Error("WINDMILL_TOKEN not set")

  const resp = await fetch(
    `${WINDMILL_BASE}/w/${WINDMILL_WORKSPACE}/jobs_u/get/${jobId}`,
    {
      headers: { Authorization: `Bearer ${WINDMILL_TOKEN}` },
    },
  )

  if (!resp.ok) throw new Error(`Windmill ${resp.status}`)
  const job = await resp.json()

  return {
    running: job.type === "QueuedJob" && job.running,
    success: job.success,
    result: job.result,
  }
}
