import "server-only"
import type { QboMinter } from "./qbo"
import type { CardCharger, ChargeAttemptResult, PaymentInstrument } from "@/lib/payments/domain/ports"

/**
 * The PROCESSOR bridge — Intuit Payments API, the system that MOVES money.
 * Deliberately separate from the accounting classes in qbo.ts (different
 * external system, different failure modes — see ports.ts).
 *
 * Ported verbatim from the proven live primitives in f/billing/_lib/qbo.py:
 * charge_card (POST /charges, cardOnFile) and charge_bank_account
 * (POST /echecks, bankAccountOnFile), with the same outcome classification:
 * network/5xx = UNKNOWN (never auto-retried — the Request-Id makes a
 * deliberate retry converge), non-ok = declined, ok = settled only when the
 * processor says so (card: CAPTURED; ach: PENDING or SUCCEEDED).
 */

const PAYMENTS_BASE = "https://api.intuit.com/quickbooks/v4/payments"

interface ChargeBody {
  id?: string
  status?: string
  authCode?: string
  card?: { cardType?: string; number?: string }
  bankAccount?: { accountNumber?: string }
}

export class QboProcessor implements CardCharger {
  constructor(private readonly minter: QboMinter) {}

  async charge(instrument: PaymentInstrument, amountCents: number, idempotencyKey: string): Promise<ChargeAttemptResult> {
    if (!instrument.onFileId) {
      return { outcome: "declined", reason: "instrument has no on-file processor id" }
    }
    const amount = (amountCents / 100).toFixed(2)
    const [path, payload] =
      instrument.kind === "ach"
        ? [
            "/echecks",
            {
              amount,
              bankAccountOnFile: instrument.onFileId,
              description: `Invoice ${idempotencyKey}`,
              paymentMode: "WEB",
              context: { deviceInfo: { macAddress: "", ipAddress: "", longitude: "", latitude: "", phoneNumber: "" } },
            },
          ]
        : [
            "/charges",
            {
              amount,
              currency: "USD",
              capture: true,
              cardOnFile: instrument.onFileId,
              description: `Invoice ${idempotencyKey}`,
              context: { mobile: false, isEcommerce: true },
            },
          ]

    let res: Response
    try {
      const keys = await this.minter.mint(false)
      res = await fetch(`${PAYMENTS_BASE}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keys.access_token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          // The processor's dedupe key IS our charge's domain identity — a
          // deliberate retry replays the SAME charge instead of a second one.
          // (Sanitized: Intuit request ids are safest as plain token chars.)
          "Request-Id": idempotencyKey.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 36),
        },
        body: JSON.stringify(payload),
      })
    } catch (e) {
      return { outcome: "unknown", detail: `network: ${String(e).slice(0, 200)}` }
    }

    const text = await res.text()
    if (res.status >= 500) return { outcome: "unknown", detail: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    let body: ChargeBody | null = null
    try {
      body = JSON.parse(text) as ChargeBody
    } catch {
      if (!res.ok) return { outcome: "declined", reason: `HTTP ${res.status}: ${text.slice(0, 200)}` }
      return { outcome: "unknown", detail: `unparseable success body: ${text.slice(0, 200)}` }
    }
    if (!res.ok) return { outcome: "declined", reason: `HTTP ${res.status}: ${text.slice(0, 300)}` }

    const status = (body.status ?? "").toUpperCase()
    const settled = instrument.kind === "ach" ? status === "PENDING" || status === "SUCCEEDED" : status === "CAPTURED"
    if (!settled || !body.id) return { outcome: "declined", reason: `processor status ${status || "(none)"}` }

    // The ECHO's card facts label the memo — what was actually charged,
    // not what the roster remembers.
    const last4 = instrument.kind === "ach" ? (body.bankAccount?.accountNumber ?? "").slice(-4) : (body.card?.number ?? "").slice(-4)
    const brand = instrument.kind === "ach" ? "ACH" : (body.card?.cardType ?? "Card")
    return {
      outcome: "settled",
      processorRef: body.id,
      authCode: body.authCode,
      label: last4 ? `${brand} x${last4}` : (instrument.label ?? undefined),
    }
  }
}
