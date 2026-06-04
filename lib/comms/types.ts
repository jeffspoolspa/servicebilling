// Domain types for the comms module.
// Mirrors CHECK constraints on public.communications, public.email_messages,
// public.text_messages.

export type Office = "richmond_hill" | "brunswick" | "st_marys"

export type CommunicationChannel = "email" | "sms" | "call" | "note"
export type CommunicationDirection = "outbound" | "inbound" | "system"
export type CommunicationStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"

// At least one of these must be set (CHECK constraint in DB).
export interface CommIdentity {
  lead_id?: string
  customer_id?: number
  task_id?: string
  service_body_id?: number
}

export interface SendEmailRequest extends CommIdentity {
  office: Office
  to: string
  cc?: string[]
  bcc?: string[]
  /** Required for raw html/text sends. Optional when `template` carries a default subject. */
  subject?: string
  body_html?: string
  body_text?: string
  in_reply_to?: string
  email_references?: string
  /** Friendly label stored on the communications row (e.g. "lead_quote"). */
  template_name?: string
  /**
   * Send via a Resend hosted template instead of html/text. `id` is the Resend
   * template UUID; `variables` fill its {{{NAME}}} placeholders. When set, do NOT
   * also pass body_html/body_text (Resend rejects both). Additive + optional —
   * existing html/text callers (website, Windmill) are unaffected.
   */
  template?: { id: string; variables?: Record<string, string | number> }
  direction?: "outbound" | "system"
  created_by?: string
  metadata?: Record<string, unknown>
  from_name_override?: string
}

export interface SendEmailResult {
  ok: boolean
  communication_id?: string
  provider_message_id?: string
  error?: string
}

export interface SendSmsRequest extends CommIdentity {
  office: Office
  to: string
  body: string
  template_name?: string
  direction?: "outbound" | "system"
  created_by?: string
  metadata?: Record<string, unknown>
}

export interface SendSmsResult {
  ok: boolean
  communication_id?: string
  provider_message_id?: string
  provider_conversation_id?: string
  status?: string
  error?: string
}
