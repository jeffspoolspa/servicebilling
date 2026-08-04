"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { createClient } from "@supabase/supabase-js"
import { requireModuleWrite } from "@/lib/auth/access"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { triggerScriptSync } from "@/lib/windmill"

export type ActionState = { ok?: string; error?: string }

/**
 * Mutations against billing.customer_payment_methods use the service-role
 * client because the schema's RLS write policy keys on a stale app value
 * ('service-billing') that no longer matches what lib/auth/modules.ts uses
 * ('service'). The access guard above is the real authorization check;
 * service-role is just how we land the write past RLS. Don't echo any data
 * from this client back to the browser.
 */
function billingAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: "billing" },
    },
  )
}

const schema = z.object({
  payment_method_id: z.string().uuid(),
  customer_id: z.string(),
})

export async function deactivatePaymentMethod(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const access = await requireModuleWrite("service")

  const parsed = schema.safeParse({
    payment_method_id: formData.get("payment_method_id"),
    customer_id: formData.get("customer_id"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  const admin = billingAdmin()
  const { error } = await admin
    .from("customer_payment_methods")
    .update({
      deactivated_at: new Date().toISOString(),
      deactivated_by: access.authUserId,
    })
    .eq("id", parsed.data.payment_method_id)

  if (error) return { error: error.message }

  revalidatePath(`/customers/${parsed.data.customer_id}/payment-methods`)
  return { ok: "Payment method deactivated. Affected invoices will refresh." }
}

export async function reactivatePaymentMethod(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireModuleWrite("service")

  const parsed = schema.safeParse({
    payment_method_id: formData.get("payment_method_id"),
    customer_id: formData.get("customer_id"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  const admin = billingAdmin()
  const { error } = await admin
    .from("customer_payment_methods")
    .update({
      deactivated_at: null,
      deactivated_by: null,
    })
    .eq("id", parsed.data.payment_method_id)

  if (error) return { error: error.message }

  revalidatePath(`/customers/${parsed.data.customer_id}/payment-methods`)
  return { ok: "Payment method reactivated." }
}

/**
 * Card capture goes through the card-vault service (secure.jeffspoolspa.com,
 * Supabase project rjxhummrmyigngdqiuic): we get a single-use capture session,
 * the iframe collects the card and vaults it in QBO — raw card data never
 * touches this app.
 *
 * We go through the vault's `collect-lookup` rather than calling `mint-session`
 * directly so VAULT_SECRET_KEY lives in exactly ONE place (the vault project)
 * instead of also being copied into this app's env. collect-lookup re-resolves
 * the customer server-side and holds the secret itself; it takes a customer id
 * and nothing else, so there is no privilege here to leak.
 */
const VAULT_FUNCTIONS_URL =
  process.env.CARD_VAULT_FUNCTIONS_URL || "https://rjxhummrmyigngdqiuic.supabase.co"

export async function mintCardCaptureSession(
  customerId: string,
): Promise<{ session?: string; expires_at?: string; error?: string }> {
  await requireModuleWrite("service")

  const sb = createSupabaseAdmin()
  const { data: customer, error } = await sb
    .from("Customers")
    .select("id, qbo_customer_id")
    .eq("id", customerId)
    .single()
  if (error || !customer) return { error: "Customer not found." }
  if (!customer.qbo_customer_id) return { error: "Customer has no QBO ID — the vault posts the card to QBO, so link QBO first." }

  const resp = await fetch(`${VAULT_FUNCTIONS_URL}/functions/v1/collect-lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "select", customer_id: customer.id }),
  })
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>
  if (!resp.ok || !body.capture_session) {
    return { error: `Vault session request failed: ${String(body.error ?? resp.status)}` }
  }
  return { session: String(body.capture_session), expires_at: String(body.expires_at) }
}

/**
 * After the vault reports card_saved, converge the cached wallet
 * (billing.customer_payment_methods) from QBO. The Windmill script is that
 * table's write path — the app never writes the cache itself.
 */
export async function refreshWalletAfterCapture(customerId: string): Promise<ActionState> {
  await requireModuleWrite("service")

  const sb = createSupabaseAdmin()
  const { data: customer } = await sb
    .from("Customers")
    .select("qbo_customer_id")
    .eq("id", customerId)
    .single()
  if (!customer?.qbo_customer_id) return { error: "Customer has no QBO ID." }

  try {
    await triggerScriptSync(
      "f/service_billing/pull_customer_payment_methods",
      { only_customer_id: String(customer.qbo_customer_id) },
      { timeoutMs: 30000 },
    )
  } catch (e) {
    // The card IS in QBO at this point; only the cache refresh failed.
    return { error: `Card saved in QBO, but the wallet cache refresh failed (${e instanceof Error ? e.message : "unknown"}). It will converge on the next sync.` }
  }

  revalidatePath(`/customers/${customerId}/payment-methods`)
  return { ok: "Wallet refreshed from QBO." }
}
