import { createClient } from "@supabase/supabase-js"

/**
 * Public anon client for server components.
 *
 * Uses the anon key (no user session) — works for any table that has either
 * RLS disabled or a permissive anon read policy. Used in local dev preview
 * where there is no logged-in user.
 *
 * Schema-aware: pass `{ schema: 'billing' }` to query the billing schema.
 */
export function createAnon(schema: "public" | "billing" = "public") {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema },
      auth: { persistSession: false },
    },
  )
}
