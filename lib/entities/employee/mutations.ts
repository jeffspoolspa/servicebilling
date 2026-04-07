import { createSupabaseServer } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

/**
 * Set the array of ION usernames for an employee. Used by the ION reconciliation admin tool.
 * Pass an empty array to clear the mapping.
 */
export async function setIonUsernames(employeeId: string, usernames: string[]): Promise<void> {
  const supabase = await createSupabaseServer()
  const { error } = await supabase
    .from("employees")
    .update({ ion_username: usernames })
    .eq("id", employeeId)
  if (error) throw error
  revalidatePath(`/employees/${employeeId}`)
  revalidatePath("/employees")
  revalidatePath("/admin/ion-mapping")
}
