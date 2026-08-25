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

/**
 * The machine credentials, in the order this codebase already established.
 * WINDMILL_TOKEN is the last of them because /api/billing/tick already trusts
 * it and BOTH sides hold it: Vercel as an env var, Supabase as the vault
 * secret `windmill_token`. A scheduler therefore needs no secret of its own —
 * which is the point. A token that only one side has is a token that silently
 * rots, which is exactly how OPERATOR_TOKEN drifted out of sync.
 *
 * This grants no new reach: anyone holding the Windmill token can already run
 * every ION and billing job in the workspace.
 */
const machineTokens = () =>
  [process.env.OPERATOR_TOKEN, process.env.CRON_SECRET, process.env.WINDMILL_TOKEN].filter(Boolean)

export async function authorize(req: Request): Promise<Caller | null> {
  const auth = req.headers.get("authorization")
  if (auth && machineTokens().some((t) => auth === `Bearer ${t}`)) return { id: "operator", viaToken: true }

  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  return user ? { id: user.id, viaToken: false } : null
}
