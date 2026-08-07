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

// ── Wallet reads (same host, other direction) ────────────────────────────────

const CUSTOMERS_BASE = "https://api.intuit.com/quickbooks/v4/customers"

/**
 * One vaulted method as the PROCESSOR describes it — a storage-shaped DTO,
 * not a domain object. The wallet repository maps these to Instruments; no
 * caller above the repository ever sees this type.
 *
 * QBO's own `default` flag is deliberately NOT surfaced as a field (the
 * Country Inn lesson): default-ness is OUR policy (Wallet.defaultInstrument),
 * never the processor's. It stays visible inside `raw` for audit only.
 */
export interface WalletMethodSnapshot {
  type: "credit_card" | "ach"
  qboPaymentMethodId: string
  brand: string | null
  lastFour: string
  raw: Record<string, unknown>
}

/**
 * The wallet fetch, ported from f/billing/_lib/payment_methods.fetch — with
 * its load-bearing law intact: AN ERRORED FETCH IS NOT AN EMPTY WALLET.
 * `errors` non-empty means we do NOT know the wallet; the caller must change
 * nothing (a refresh that treats a timeout as "no cards" deactivates every
 * instrument and silently routes the customer to email — Judy's failure
 * mode, manufactured by a network blip).
 */
export class QboWalletSource {
  constructor(private readonly minter: QboMinter) {}

  async fetch(qboCustomerId: string): Promise<{ methods: WalletMethodSnapshot[]; errors: string[] }> {
    const methods: WalletMethodSnapshot[] = []
    const errors: string[] = []

    const [cards, cardsErr] = await this.get(`${CUSTOMERS_BASE}/${qboCustomerId}/cards`, "cards")
    if (cardsErr) errors.push(cardsErr)
    else
      for (const c of cards) {
        if (c.status !== "ACTIVE") continue
        methods.push({
          type: "credit_card",
          qboPaymentMethodId: String(c.id),
          brand: (c.cardType as string) ?? null,
          lastFour: String(c.number ?? "").slice(-4),
          raw: c,
        })
      }

    const [banks, banksErr] = await this.get(`${CUSTOMERS_BASE}/${qboCustomerId}/bank-accounts`, "bank")
    if (banksErr) errors.push(banksErr)
    else
      for (const b of banks) {
        if (b.verificationStatus !== "VERIFIED" && b.verificationStatus !== "NOT_VERIFIED") continue
        methods.push({
          type: "ach",
          qboPaymentMethodId: String(b.id),
          brand: (b.bankName as string) ?? null,
          lastFour: String(b.accountNumber ?? "").slice(-4),
          raw: b,
        })
      }

    return { methods, errors }
  }

  /** GET with 429 backoff (2^attempt seconds, 3 tries) — never throws: the
   *  caller must be able to tell "QBO said none" apart from "QBO won't say". */
  private async get(
    url: string,
    label: string,
    maxRetries = 3,
  ): Promise<[Record<string, unknown>[], string | null]> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let res: Response
      try {
        const keys = await this.minter.mint(false)
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${keys.access_token}`, Accept: "application/json" },
        })
      } catch (e) {
        return [[], `${label}: ${String(e).slice(0, 200)}`]
      }
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000))
        continue
      }
      if (!res.ok) return [[], `${label}: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`]
      try {
        const body: unknown = await res.json()
        return [Array.isArray(body) ? (body as Record<string, unknown>[]) : [], null]
      } catch {
        return [[], `${label}: response was not JSON`]
      }
    }
    return [[], `${label}: rate limited after ${maxRetries} attempts`]
  }
}
