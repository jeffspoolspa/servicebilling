import { ObjectHeader } from "@/components/shell/object-header"
import { Users } from "lucide-react"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { createSupabaseServer } from "@/lib/supabase/server"
import { TECH_EMAIL_DOMAIN } from "@/lib/auth/tech"
import { UsersTable, type AppUserRow } from "./UsersTable"

export const dynamic = "force-dynamic"

/**
 * App users management page.
 *
 * Lists every Supabase auth user that ISN'T a maintenance tech (those have
 * synthetic emails at @techs.jeffspoolspa.internal and are managed on the
 * Tech Users page) along with their current module access from app_roles.
 *
 * Admin can:
 *   - Add a new user (email + password + module access)
 *   - Edit access for an existing user (toggle modules + roles)
 *   - Reset a user's password
 *   - Deactivate a user (deletes auth row + app_roles)
 */
export default async function AppUsersPage() {
  const admin = createSupabaseAdmin()
  const server = await createSupabaseServer()

  // List ALL auth users via the admin API (paginated; one page is fine for now)
  const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 200 })

  // Pull all app_roles rows in one query and group by user.
  const { data: roleRows } = await server
    .from("app_roles")
    .select("auth_user_id, app, role")
  const rolesByUser = new Map<string, Array<{ app: string; role: string }>>()
  for (const r of roleRows ?? []) {
    const list = rolesByUser.get(r.auth_user_id as string) ?? []
    list.push({ app: r.app as string, role: r.role as string })
    rolesByUser.set(r.auth_user_id as string, list)
  }

  // Filter out tech users (synthetic emails); they're managed elsewhere.
  const techDomain = `@${TECH_EMAIL_DOMAIN}`
  const rows: AppUserRow[] = users
    .filter((u) => !(u.email ?? "").toLowerCase().endsWith(techDomain))
    .map((u) => ({
      auth_user_id: u.id,
      email: u.email ?? "—",
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      access: rolesByUser.get(u.id) ?? [],
    }))
    .sort((a, b) => a.email.localeCompare(b.email))

  return (
    <>
      <ObjectHeader
        eyebrow="Admin"
        title="App Users"
        sub="Email/password logins for office staff. Tech-username logins are on the Tech Users page."
        icon={<Users className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6 max-w-4xl">
        <UsersTable rows={rows} />
      </div>
    </>
  )
}
