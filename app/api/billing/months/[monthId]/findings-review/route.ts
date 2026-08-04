import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"

/**
 * MARK REVIEWED — a person resolving flagged visits. RULED: a billing
 * month needs no unresolved flagged visits to issue; reviewing IS the
 * resolution (resolution='reviewed'), and the next re-gate releases the
 * month's findings hold on its own.
 */
export async function POST(req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { finding_ids?: number[]; all?: boolean }
  const sys = createSupabaseAdmin()

  let q = (sys.schema("billing").from("findings") as never as {
    update(v: Record<string, unknown>): {
      eq(c: string, v2: unknown): { is(c2: string, v3: null): { in(c3: string, v4: number[]): { select(c4: string): PromiseLike<{ data: unknown[] | null; error: unknown }> } } & { select(c4: string): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
    }
  })
    .update({ resolved_at: new Date().toISOString(), resolved_by: user.email ?? user.id, resolution: "reviewed" })
    .eq("billing_month_id", monthId)
    .is("resolved_at", null)
  const res = body.all
    ? await q.select("id")
    : await q.in("id", body.finding_ids ?? []).select("id")
  if (res.error) return NextResponse.json({ error: String(JSON.stringify(res.error)).slice(0, 200) }, { status: 500 })
  return NextResponse.json({ reviewed: (res.data ?? []).length })
}
