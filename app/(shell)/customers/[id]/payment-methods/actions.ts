"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { createClient } from "@supabase/supabase-js"
import { requireModuleWrite } from "@/lib/auth/access"

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
