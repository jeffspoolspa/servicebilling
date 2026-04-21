import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { KeyRound } from "lucide-react"
import { createSupabaseServer } from "@/lib/supabase/server"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"
import { TechUsersTable } from "./TechUsersTable"

export default async function TechUsersPage() {
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .from("employees")
    .select("id, first_name, last_name, employee_code, tech_username, auth_user_id")
    .eq("status", "active")
    .eq("department_id", MAINTENANCE_DEPARTMENT_ID)
    .order("first_name", { ascending: true })

  const rows = (data ?? []).map((e) => ({
    id: e.id as string,
    display_name:
      [e.first_name, e.last_name].filter(Boolean).join(" ") ||
      (e.employee_code as string | null) ||
      "Unknown",
    tech_username: (e.tech_username as string | null) ?? null,
    has_login: Boolean(e.auth_user_id),
  }))

  return (
    <>
      <Topbar crumbs={[{ label: "Admin", href: "/admin" }, { label: "Tech Users" }]} />
      <ObjectHeader
        eyebrow="Admin"
        title="Tech Users"
        sub="Manage username + password logins for maintenance technicians using the /sign-out form."
        icon={<KeyRound className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6 max-w-3xl">
        <TechUsersTable rows={rows} />
      </div>
    </>
  )
}
