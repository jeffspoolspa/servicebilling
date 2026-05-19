import "server-only"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import type { CommunicationChannel, CommunicationDirection } from "../types"

/**
 * DB-write helpers for the communications schema. Every outbound message
 * pre-writes the parent + child as `status=pending`, then this module updates
 * the row to `sent`/`failed`/`delivered` based on the provider response or
 * webhook event. Reuses the project's existing createSupabaseAdmin().
 */

export interface InsertPendingArgs {
  channel: CommunicationChannel
  direction: CommunicationDirection
  lead_id?: string
  customer_id?: number
  task_id?: string
  service_body_id?: number
  from_address?: string
  to_address: string
  provider: string
  template_name?: string
  metadata?: Record<string, unknown>
  created_by?: string
}

export async function insertPendingCommunication(args: InsertPendingArgs): Promise<string> {
  const supabase = createSupabaseAdmin()
  const { data, error } = await supabase
    .from("communications")
    .insert({
      channel: args.channel,
      direction: args.direction,
      lead_id: args.lead_id ?? null,
      customer_id: args.customer_id ?? null,
      task_id: args.task_id ?? null,
      service_body_id: args.service_body_id ?? null,
      status: "pending",
      requested_at: new Date().toISOString(),
      from_address: args.from_address ?? null,
      to_address: args.to_address,
      provider: args.provider,
      template_name: args.template_name ?? null,
      metadata: args.metadata ?? {},
      created_by: args.created_by ?? "system",
    })
    .select("id")
    .single()
  if (error || !data) {
    throw error ?? new Error("insert into communications failed")
  }
  return data.id as string
}

export interface InsertEmailMessageArgs {
  communication_id: string
  subject: string
  body_html?: string
  body_text?: string
  cc?: readonly string[]
  bcc?: readonly string[]
  in_reply_to?: string
  email_references?: string
}

export async function insertEmailMessage(args: InsertEmailMessageArgs): Promise<void> {
  const supabase = createSupabaseAdmin()
  const { error } = await supabase.from("email_messages").insert({
    communication_id: args.communication_id,
    subject: args.subject,
    body_html: args.body_html ?? null,
    body_text: args.body_text ?? null,
    cc_addresses: args.cc && args.cc.length ? Array.from(args.cc) : null,
    bcc_addresses: args.bcc && args.bcc.length ? Array.from(args.bcc) : null,
    in_reply_to: args.in_reply_to ?? null,
    email_references: args.email_references ?? null,
  })
  if (error) throw error
}

export interface InsertTextMessageArgs {
  communication_id: string
  body: string
}

export async function insertTextMessage(args: InsertTextMessageArgs): Promise<void> {
  const supabase = createSupabaseAdmin()
  const { error } = await supabase.from("text_messages").insert({
    communication_id: args.communication_id,
    body: args.body,
  })
  if (error) throw error
}

export async function markSent(args: { communication_id: string }): Promise<void> {
  const supabase = createSupabaseAdmin()
  const { error } = await supabase
    .from("communications")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", args.communication_id)
  if (error) throw error
}

export async function markFailed(args: {
  communication_id: string
  error_message: string
}): Promise<void> {
  const supabase = createSupabaseAdmin()
  const { error } = await supabase
    .from("communications")
    .update({
      status: "failed",
      error_message: args.error_message.slice(0, 2000),
    })
    .eq("id", args.communication_id)
  if (error) throw error
}

export async function setProviderIds(args: {
  table: "email_messages" | "text_messages"
  communication_id: string
  fields: Record<string, string | null>
}): Promise<void> {
  const supabase = createSupabaseAdmin()
  const { error } = await supabase
    .from(args.table)
    .update(args.fields)
    .eq("communication_id", args.communication_id)
  if (error) throw error
}

// ── Webhook-driven updates ─────────────────────────────────────────────────
// Called by the Resend webhook receiver when delivery events arrive.

export async function lookupCommunicationByProviderMessageId(
  table: "email_messages" | "text_messages",
  providerMessageId: string,
): Promise<string | null> {
  const supabase = createSupabaseAdmin()
  const { data, error } = await supabase
    .from(table)
    .select("communication_id")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle()
  if (error || !data) return null
  return data.communication_id as string
}

export async function markDelivered(args: {
  communication_id: string
  delivered_at?: string
}): Promise<void> {
  const supabase = createSupabaseAdmin()
  // Only set status=delivered if it's currently sent (don't downgrade a failed
  // row to delivered, and don't overwrite read with delivered).
  const { error } = await supabase
    .from("communications")
    .update({
      status: "delivered",
      delivered_at: args.delivered_at ?? new Date().toISOString(),
    })
    .eq("id", args.communication_id)
    .in("status", ["sent"])
  if (error) throw error
}

export async function markRead(args: {
  communication_id: string
  read_at?: string
}): Promise<void> {
  const supabase = createSupabaseAdmin()
  // Only the FIRST open sets read_at. Subsequent opens are ignored to keep
  // the value meaningful (first-open time).
  const { error } = await supabase
    .from("communications")
    .update({
      status: "read",
      read_at: args.read_at ?? new Date().toISOString(),
    })
    .eq("id", args.communication_id)
    .is("read_at", null)
  if (error) throw error
}
