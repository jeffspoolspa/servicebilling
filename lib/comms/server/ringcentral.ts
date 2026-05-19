import "server-only"
import { SDK } from "@ringcentral/sdk"
import { RC_OFFICE_CONFIG } from "../office-config"
import {
  insertPendingCommunication,
  insertTextMessage,
  markSent,
  markFailed,
  setProviderIds,
} from "./communications-db"
import type { SendSmsRequest, SendSmsResult } from "../types"

/**
 * RingCentral SMS transport. JWT bearer auth + REST API via the SDK.
 *
 * Required env vars:
 *   RC_APP_CLIENT_ID         — RC app client ID
 *   RC_APP_CLIENT_SECRET     — RC app client secret
 *   RC_JWT_PP                — JWT for richmond_hill (+19124590160)
 *   RC_JWT_USER              — JWT for brunswick + st_marys (+19125540636)
 */

const RC_SERVER = "https://platform.ringcentral.com"

type RcPlatform = ReturnType<SDK["platform"]>
const platformCache = new Map<string, RcPlatform>()

async function getPlatformForJwtEnv(jwtEnv: string): Promise<RcPlatform> {
  const cached = platformCache.get(jwtEnv)
  if (cached) return cached

  const clientId = process.env.RC_APP_CLIENT_ID
  const clientSecret = process.env.RC_APP_CLIENT_SECRET
  const jwt = process.env[jwtEnv]
  if (!clientId || !clientSecret || !jwt) {
    throw new Error(
      `Missing RingCentral env vars (need RC_APP_CLIENT_ID, RC_APP_CLIENT_SECRET, ${jwtEnv})`,
    )
  }

  const sdk = new SDK({ server: RC_SERVER, clientId, clientSecret })
  const platform = sdk.platform()
  await platform.login({ jwt })
  platformCache.set(jwtEnv, platform)
  return platform
}

const extensionCache = new Map<string, string>()

async function getExtensionIdForNumber(
  platform: RcPlatform,
  phoneNumber: string,
): Promise<string> {
  const cached = extensionCache.get(phoneNumber)
  if (cached) return cached

  const extRes = await platform.get("/restapi/v1.0/account/~/extension")
  const extData = (await extRes.json()) as { records: Array<{ id: number }> }
  for (const ext of extData.records) {
    const numRes = await platform.get(
      `/restapi/v1.0/account/~/extension/${ext.id}/phone-number`,
    )
    const numData = (await numRes.json()) as {
      records: Array<{ phoneNumber: string; features?: string[] }>
    }
    for (const num of numData.records) {
      if (
        num.phoneNumber === phoneNumber &&
        (num.features ?? []).includes("SmsSender")
      ) {
        const id = String(ext.id)
        extensionCache.set(phoneNumber, id)
        return id
      }
    }
  }
  throw new Error(`No SMS-capable extension found for ${phoneNumber}`)
}

function normalizePhone(raw: string): string {
  const digits = (raw ?? "").replace(/\D/g, "")
  if (digits.length === 10) return "+1" + digits
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits
  if (raw && raw.startsWith("+")) return raw
  throw new Error(`Invalid phone number: ${raw}`)
}

async function checkDeliveryStatus(
  platform: RcPlatform,
  messageId: string,
  maxAttempts = 20,
): Promise<string> {
  const endpoint = `/restapi/v1.0/account/~/extension/~/message-store/${messageId}`
  for (let i = 0; i < maxAttempts; i++) {
    const res = await platform.get(endpoint)
    const data = (await res.json()) as { messageStatus?: string }
    if (data.messageStatus && data.messageStatus !== "Queued") {
      return data.messageStatus
    }
    await new Promise((r) => setTimeout(r, 4000))
  }
  return "Timeout"
}

export async function sendSms(req: SendSmsRequest): Promise<SendSmsResult> {
  if (!req.lead_id && !req.customer_id && !req.task_id && !req.service_body_id) {
    return { ok: false, error: "identity_required" }
  }
  if (!req.to) return { ok: false, error: "to_required" }
  if (!req.body || !req.body.trim()) return { ok: false, error: "body_required" }

  const officeConfig = RC_OFFICE_CONFIG[req.office]
  if (!officeConfig) return { ok: false, error: `unknown_office:${req.office}` }

  let recipient: string
  try {
    recipient = normalizePhone(req.to)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  let communicationId: string
  try {
    communicationId = await insertPendingCommunication({
      channel: "sms",
      direction: req.direction ?? "outbound",
      lead_id: req.lead_id,
      customer_id: req.customer_id,
      task_id: req.task_id,
      service_body_id: req.service_body_id,
      from_address: officeConfig.from_number,
      to_address: recipient,
      provider: "ringcentral",
      template_name: req.template_name,
      metadata: { office: req.office, ...(req.metadata ?? {}) },
      created_by: req.created_by ?? "system:send-sms",
    })
    await insertTextMessage({
      communication_id: communicationId,
      body: req.body,
    })
  } catch (e) {
    return { ok: false, error: `db_insert_failed:${(e as Error).message}` }
  }

  try {
    const platform = await getPlatformForJwtEnv(officeConfig.jwt_env)
    const extId = await getExtensionIdForNumber(platform, officeConfig.from_number)

    const sendRes = await platform.post(
      `/restapi/v1.0/account/~/extension/${extId}/sms`,
      {
        from: { phoneNumber: officeConfig.from_number },
        to: [{ phoneNumber: recipient }],
        text: req.body,
      },
    )
    const sendData = (await sendRes.json()) as {
      id?: string
      conversationId?: string
    }
    const messageId = sendData.id
    const conversationId = sendData.conversationId
    if (!messageId) {
      throw new Error("RingCentral send did not return a message id")
    }

    const status = await checkDeliveryStatus(platform, messageId)
    if (status === "SendingFailed" || status === "DeliveryFailed") {
      throw new Error(`RC final status: ${status}`)
    }

    await setProviderIds({
      table: "text_messages",
      communication_id: communicationId,
      fields: {
        provider_message_id: messageId,
        provider_conversation_id: conversationId ?? null,
      },
    })
    await markSent({ communication_id: communicationId })

    return {
      ok: true,
      communication_id: communicationId,
      provider_message_id: messageId,
      provider_conversation_id: conversationId,
      status,
    }
  } catch (e) {
    const msg = (e as Error).message || String(e)
    await markFailed({
      communication_id: communicationId,
      error_message: msg,
    }).catch(() => {})
    return { ok: false, communication_id: communicationId, error: msg }
  }
}
