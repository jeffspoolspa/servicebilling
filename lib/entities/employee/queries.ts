import { createSupabaseServer } from "@/lib/supabase/server"
import type { Employee } from "./types"

export async function listEmployees(opts?: { activeOnly?: boolean }): Promise<Employee[]> {
  const supabase = await createSupabaseServer()
  let query = supabase
    .from("employees")
    .select("*")
    .order("first_name", { ascending: true })

  if (opts?.activeOnly) query = query.eq("status", "active")

  const { data } = await query
  return (data ?? []).map(enrich)
}

export async function getEmployee(id: string): Promise<Employee | null> {
  const supabase = await createSupabaseServer()
  const { data } = await supabase.from("employees").select("*").eq("id", id).single()
  if (!data) return null
  return enrich(data)
}

/** For the ION reconciliation admin tool. */
export async function listUnmappedTechnicians() {
  const supabase = await createSupabaseServer()
  const { data } = await supabase.rpc("list_unmapped_technicians")
  return data ?? []
}

function enrich(row: Record<string, unknown>): Employee {
  const first = (row.first_name as string) ?? ""
  const last = (row.last_name as string) ?? ""
  return {
    id: row.id as string,
    gusto_uuid: (row.gusto_uuid as string) ?? null,
    employee_code: (row.employee_code as string) ?? null,
    first_name: first || null,
    last_name: last || null,
    display_name: `${first} ${last}`.trim() || (row.employee_code as string) || "Unknown",
    email: (row.email as string) ?? null,
    phone: (row.phone as string) ?? null,
    status: ((row.status as Employee["status"]) ?? "active") as Employee["status"],
    hire_date: (row.hire_date as string) ?? null,
    department_id: (row.department_id as string) ?? null,
    branch_id: (row.branch_id as string) ?? null,
    ion_username: (row.ion_username as string[]) ?? null,
    auth_user_id: (row.auth_user_id as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}
