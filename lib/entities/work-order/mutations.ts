import { createSupabaseServer } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import type { BillingStatus } from "./types"

export async function setBillingStatus(
  id: string,
  status: BillingStatus,
  reason?: string,
): Promise<void> {
  const supabase = await createSupabaseServer()
  const { error } = await supabase
    .from("work_orders")
    .update({
      billing_status: status,
      needs_review_reason: status === "needs_review" ? (reason ?? null) : null,
    })
    .eq("id", id)
  if (error) throw error
  revalidatePath(`/work-orders/${id}`)
  revalidatePath("/service-billing/queue")
}
