import { ObjectHeader } from "@/components/shell/object-header"
import { KeyRound } from "lucide-react"
import { createSupabaseServer } from "@/lib/supabase/server"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"
import { TechUsersTable } from "./TechUsersTable"

export default async function TechUsersPage() {
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .from("employees")
    .select("id, first_name, last_name, employee_code, email, department_id, tech_username, auth_user_id")
    .eq("status", "active")
    .order("first_name", { ascending: true })

  const toRow = (e: NonNullable<typeof data>[number]) => ({
    id: e.id as string,
    display_name:
      [e.first_name, e.last_name].filter(Boolean).join(" ") ||
      (e.employee_code as string | null) ||
      "Unknown",
    email: (e.email as string | null) ?? null,
    tech_username: (e.tech_username as string | null) ?? null,
    has_login: Boolean(e.auth_user_id),
  })

  const rows = (data ?? [])
    .filter((e) => e.department_id === MAINTENANCE_DEPARTMENT_ID)
    .map(toRow)
  // Office = everyone else with a work email to match an office login against.
  const officeRows = (data ?? [])
    .filter((e) => e.department_id !== MAINTENANCE_DEPARTMENT_ID && e.email)
    .map(toRow)

  return (
    <>
      <ObjectHeader
        eyebrow="Admin"
        title="Tech Users"
        sub="Username + password logins for maintenance techs, plus mobile-app access for office staff under their office identity."
        icon={<KeyRound className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6 max-w-3xl">
        <TechUsersTable rows={rows} officeRows={officeRows} />
      </div>
    </>
  )
}
