import "server-only"
import type { MaintQuote } from "@/lib/leads/quote"
import { EMAIL_OFFICE_BRANDING, RC_OFFICE_CONFIG } from "./office-config"
import type { Office } from "./types"

/**
 * Outbound message templates, keyed by a friendly name. Email bodies are HOSTED
 * IN RESEND (referenced by UUID held in env) — we only pass the template name +
 * dynamic variables; the wording lives in the Resend dashboard. SMS has no hosted
 * template store (RingCentral), so SMS bodies render here in code.
 *
 * `resendTemplateId()` returns null when the env id is unset → the caller skips
 * the email send gracefully (same pattern as the Maps key). Friendly name →
 * Resend UUID resolution lives here so callers never hard-code a UUID.
 */

export interface LeadQuoteContext {
  firstName: string
  office: Office
  quote: MaintQuote
  /** Human label for the cadence, e.g. "weekly", "bi-weekly", "twice-weekly". */
  visitFrequencyLabel: string
}

function officeName(office: Office): string {
  return EMAIL_OFFICE_BRANDING[office].from_name
}

/** +19125540636 → (912) 554-0636 for human-facing copy. */
function officePhone(office: Office): string {
  const raw = RC_OFFICE_CONFIG[office].from_number.replace(/\D/g, "")
  const d = raw.length === 11 && raw.startsWith("1") ? raw.slice(1) : raw
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : RC_OFFICE_CONFIG[office].from_number
}

/**
 * The lead-quote message: greets the customer, states the estimated monthly
 * (labor + est. chemicals), and points them back to the office. The Resend
 * template should reference these variables with triple-brace syntax, e.g.
 * `{{{FIRST_NAME}}}`, `{{{MONTHLY_TOTAL}}}`.
 *
 * Variable contract (all values are plain strings/numbers; no $ — put the symbol
 * in the template copy):
 *   FIRST_NAME, OFFICE_NAME, OFFICE_PHONE, VISIT_FREQUENCY,
 *   PER_VISIT, LABOR_MONTHLY, CHEM_ESTIMATE,
 *   MONTHLY_TOTAL, MONTHLY_LOW, MONTHLY_HIGH
 */
export const leadQuoteTemplate = {
  name: "lead_quote" as const,

  resendTemplateId(): string | null {
    return process.env.RESEND_TEMPLATE_LEAD_QUOTE || null
  },

  variables(ctx: LeadQuoteContext): Record<string, string | number> {
    const total = ctx.quote.monthlyTotal?.median ?? ctx.quote.laborMonthly
    return {
      FIRST_NAME: ctx.firstName,
      OFFICE_NAME: officeName(ctx.office),
      OFFICE_PHONE: officePhone(ctx.office),
      VISIT_FREQUENCY: ctx.visitFrequencyLabel,
      PER_VISIT: ctx.quote.perVisit,
      LABOR_MONTHLY: ctx.quote.laborMonthly,
      CHEM_ESTIMATE: ctx.quote.chem?.median ?? 0,
      MONTHLY_TOTAL: total,
      MONTHLY_LOW: ctx.quote.monthlyTotal?.low ?? ctx.quote.laborMonthly,
      MONTHLY_HIGH: ctx.quote.monthlyTotal?.high ?? ctx.quote.laborMonthly,
    }
  },

  sms(ctx: LeadQuoteContext): string {
    const total = ctx.quote.monthlyTotal?.median ?? ctx.quote.laborMonthly
    return (
      `Hi ${ctx.firstName}, thanks for reaching out to ${officeName(ctx.office)}! ` +
      `Your estimated ${ctx.visitFrequencyLabel} pool service is about $${total}/mo ` +
      `(labor $${ctx.quote.laborMonthly} + est. chemicals). We'll follow up shortly — ` +
      `questions? Call ${officePhone(ctx.office)}.`
    )
  },
}
