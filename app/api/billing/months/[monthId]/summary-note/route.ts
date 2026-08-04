import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

/** Save the month's person-written summary note. */
export async function PATCH(req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const { note } = (await req.json().catch(() => ({}))) as { note?: string }
  const sys = createSupabaseAdmin()
  const { error } = await (sys.schema("billing").from("billing_months") as unknown as {
    update(v: Record<string, unknown>): { eq(c: string, x: string): PromiseLike<{ error: unknown }> }
  }).update({ summary_note: note ?? null }).eq("id", monthId)
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 })
  return NextResponse.json({ ok: true })
}
