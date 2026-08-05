/**
 * Who may invoke a use case: a signed-in operator, or a caller holding the
 * operator token.
 *
 * The endpoints ARE the presentation layer, and they are not the browser's
 * private property — a terminal drives the same use cases, so it authenticates
 * the same way rather than reaching past them into the services. Without this
 * a command line has to wire the ports itself, and a second wiring is a second
 * place for behaviour to live (which is how task.edit and publish came to
 * choose different dates from the same rule).
 */
import { createSupabaseServer } from "@/lib/supabase/server"

export interface Caller {
  /** A user id, or "operator" for token-authenticated automation. */
  id: string
  viaToken: boolean
}

export async function authorize(req: Request): Promise<Caller | null> {
  const token = process.env.OPERATOR_TOKEN ?? process.env.CRON_SECRET
  const auth = req.headers.get("authorization")
  if (token && auth === `Bearer ${token}`) return { id: "operator", viaToken: true }

  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  return user ? { id: user.id, viaToken: false } : null
}
