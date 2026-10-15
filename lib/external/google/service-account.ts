import "server-only"
import { createSign } from "node:crypto"

/**
 * Google service-account access tokens with domain-wide delegation.
 *
 * GOOGLE_SERVICE_ACCOUNT_JSON holds the downloaded key file (raw JSON or
 * base64 of it). The service account is
 * onboarding-mailer@jps-candidate-onboarding.iam.gserviceaccount.com; DWD
 * grants it gmail.compose, gmail.readonly and drive on the jeffspoolspa.com
 * Workspace. We always impersonate one mailbox (`subject`).
 *
 * No googleapis dependency: the JWT bearer grant is one signed POST.
 */
export const SCOPES = {
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
  gmailReadonly: "https://www.googleapis.com/auth/gmail.readonly",
  drive: "https://www.googleapis.com/auth/drive",
} as const

interface KeyFile {
  client_email: string
  private_key: string
  token_uri?: string
}

let cachedKey: KeyFile | null = null
function keyFile(): KeyFile {
  if (cachedKey) return cachedKey
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set")
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")
  const parsed = JSON.parse(text) as KeyFile
  if (!parsed.client_email || !parsed.private_key) throw new Error("service account key is missing client_email/private_key")
  cachedKey = parsed
  return parsed
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url")

const tokenCache = new Map<string, { token: string; exp: number }>()

export async function accessToken(subject: string, scopes: string[]): Promise<string> {
  const cacheKey = `${subject}|${[...scopes].sort().join(" ")}`
  const hit = tokenCache.get(cacheKey)
  if (hit && hit.exp - 60 > Date.now() / 1000) return hit.token

  const key = keyFile()
  const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token"
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = b64url(
    JSON.stringify({ iss: key.client_email, sub: subject, scope: scopes.join(" "), aud: tokenUri, iat: now, exp: now + 3600 }),
  )
  const signer = createSign("RSA-SHA256")
  signer.update(`${header}.${claims}`)
  const sig = signer.sign(key.private_key).toString("base64url")

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${sig}`,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!res.ok || !body.access_token) {
    throw new Error(`google token exchange failed (${res.status}): ${body.error ?? ""} ${body.error_description ?? ""}`.trim())
  }
  tokenCache.set(cacheKey, { token: body.access_token, exp: now + (body.expires_in ?? 3600) })
  return body.access_token
}

export async function googleFetch(
  subject: string,
  scopes: string[],
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await accessToken(subject, scopes)
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${token}`)
  return fetch(url, { ...init, headers })
}

export async function googleJson<T>(subject: string, scopes: string[], url: string, init: RequestInit = {}): Promise<T> {
  const res = await googleFetch(subject, scopes, url, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`google ${init.method ?? "GET"} ${new URL(url).pathname} failed (${res.status}): ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : {}) as T
}
