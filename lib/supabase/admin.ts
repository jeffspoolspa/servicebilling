import "server-only"
import { createClient } from "@supabase/supabase-js"

/**
 * Service-role Supabase client. NEVER import from a client component or route that
 * echoes data to the browser — this key bypasses RLS.
 *
 * Currently used by /admin/tech-users actions to create/update/delete Supabase
 * auth users for maintenance technicians.
 */
export function createSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  )
}
