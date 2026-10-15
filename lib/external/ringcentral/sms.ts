import "server-only"
import { SDK } from "@ringcentral/sdk"
import { RC_OFFICE_CONFIG } from "@/lib/comms/office-config"
import type { Office } from "@/lib/comms/types"

/**
 * Bare RingCentral SMS send for the onboarding context. Same RC app, JWTs and
 * office numbers as lib/comms/server/ringcentral.ts, but it does NOT write to
 * the customer communications tables (candidates aren't customers/leads);
 * onboarding logs its own sends in onboarding.outbound_emails + events.
 *
 * Env: RC_APP_CLIENT_ID, RC_APP_CLIENT_SECRET, and RC_JWT_PP / RC_JWT_JPS / RC_JWT_USER.
 */
const RC_SERVER = "https://platform.ringcentral.com"
type Platform = ReturnType<SDK["platform"]>
const platforms = new Map<string, Platform>()
const extensions = new Map<string, string>()

async function platformFor(jwtEnv: string): Promise<Platform> {
  const hit = platforms.get(jwtEnv)
  if (hit) return hit
  const { RC_APP_CLIENT_ID: clientId, RC_APP_CLIENT_SECRET: clientSecret } = process.env
  const jwt = process.env[jwtEnv]
  if (!clientId || !clientSecret || !jwt) throw new Error(`RingCentral env missing (RC_APP_CLIENT_ID, RC_APP_CLIENT_SECRET, ${jwtEnv})`)
  const platform = new SDK({ server: RC_SERVER, clientId, clientSecret }).platform()
  await platform.login({ jwt })
  platforms.set(jwtEnv, platform)
  return platform
}

async function extensionFor(platform: Platform, number: string): Promise<string> {
  const hit = extensions.get(number)
  if (hit) return hit
  const exts = (await (await platform.get("/restapi/v1.0/account/~/extension")).json()) as { records: { id: number }[] }
  for (const ext of exts.records) {
    const nums = (await (await platform.get(`/restapi/v1.0/account/~/extension/${ext.id}/phone-number`)).json()) as {
      records: { phoneNumber: string; features?: string[] }[]
    }
    if (nums.records.some((n) => n.phoneNumber === number && (n.features ?? []).includes("SmsSender"))) {
      extensions.set(number, String(ext.id))
      return String(ext.id)
    }
  }
  throw new Error(`no SMS-capable RingCentral extension for ${number}`)
}

export function e164(raw: string): string {
  const d = raw.replace(/\D/g, "")
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith("1")) return `+${d}`
  throw new Error("invalid US phone number")
}

export async function sendText(office: Office, to: string, body: string): Promise<{ id: string }> {
  const cfg = RC_OFFICE_CONFIG[office]
  if (!cfg) throw new Error(`unknown RingCentral office ${office}`)
  // Production carries RC_JWT_PP and RC_JWT_JPS; RC_JWT_USER (the comms
  // config's Brunswick/St Marys JWT) may be absent, so try the configured JWT
  // first, then the others, until one can send from the office number.
  const jwtEnvs = Array.from(new Set([cfg.jwt_env, "RC_JWT_JPS", "RC_JWT_USER", "RC_JWT_PP"])).filter((k) => process.env[k])
  if (!jwtEnvs.length) throw new Error("no RingCentral JWT in the environment")
  let lastErr: unknown
  for (const jwtEnv of jwtEnvs) {
    try {
      const platform = await platformFor(jwtEnv)
      const ext = await extensionFor(platform, cfg.from_number)
      const res = await platform.post(`/restapi/v1.0/account/~/extension/${ext}/sms`, {
        from: { phoneNumber: cfg.from_number },
        to: [{ phoneNumber: e164(to) }],
        text: body,
      })
      const data = (await res.json()) as { id?: string | number }
      if (!data.id) throw new Error("RingCentral send returned no message id")
      return { id: String(data.id) }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
