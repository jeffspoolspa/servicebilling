import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Branches whose techs get the follow-up-only tech app: no Inventory module
 * (truck-check / sign-out), just the Field Follow-Up form. RH + Savannah run
 * their own inventory process outside this app.
 */
const FOLLOW_UP_ONLY_BRANCHES = ["Richmond Hill, GA", "Savannah, GA", "Saint Marys, GA"]

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

/** Individuals whose Dosing tab shows the offline calculator regardless of branch. */
const OFFLINE_DOSING_USERNAMES = ["rdoyle", "ecowan"]

/**
 * Who gets the standalone offline calculator on the Dosing tab instead of the
 * API-backed pour sheet: RH/Savannah techs (whole branches), plus named
 * individuals (ruled 2026-08-18).
 */
export async function usesOfflineDosing(
  employee: { branch_id: string | null; tech_username?: string | null } | null,
): Promise<boolean> {
  if (!employee) return false
  if (employee.tech_username && OFFLINE_DOSING_USERNAMES.includes(employee.tech_username)) {
    return true
  }
  return isFollowUpOnly(employee)
}
