import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * VIEW the generated explainer. Supabase Storage deliberately serves HTML
 * as text/plain on its public domain (XSS protection), so this thin proxy
 * returns the stored letter with its real content type. This is the
 * stable internal link; regeneration replaces the object underneath it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const r = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/explainers/${monthId}.html`,
    { cache: "no-store" },
  )
  if (!r.ok) return NextResponse.json({ error: "no generated explainer for this month yet" }, { status: 404 })
  return new NextResponse(await r.text(), { headers: { "Content-Type": "text/html; charset=utf-8" } })
}
