import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Branches whose techs get the follow-up-only tech app: no Inventory module
 * (truck-check / sign-out), just the Field Follow-Up form. RH + Savannah run
 * their own inventory process outside this app.
 */
const FOLLOW_UP_ONLY_BRANCHES = ["Richmond Hill, GA", "Savannah, GA"]

export async function isFollowUpOnly(
  employee: { branch_id: string | null } | null,
): Promise<boolean> {
  if (!employee?.branch_id) return false
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .from("branches")
    .select("name")
    .eq("id", employee.branch_id)
    .single()
  return !!data && FOLLOW_UP_ONLY_BRANCHES.includes(data.name)
}
