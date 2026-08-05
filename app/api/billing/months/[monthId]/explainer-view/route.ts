import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * VIEW the generated explainer. Supabase Storage deliberately serves HTML
 * as text/plain on its public domain (XSS protection), so this thin proxy
 * returns the stored letter with its real content type. This is the
 * stable internal link; regeneration replaces the object underneath it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  const sb = await createSupabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const { monthId } = await ctx.params
  const r = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/explainers/${monthId}.html`,
    { cache: "no-store" },
  )
  if (!r.ok) return NextResponse.json({ error: "no generated explainer for this month yet" }, { status: 404 })
  const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" }
  const params = new URL(req.url).searchParams
  if (params.get("download") === "1") {
    headers["Content-Disposition"] = `attachment; filename="explainer-${monthId.slice(0, 8)}.html"`
  }
  let html = await r.text()
  if (params.get("thumb") === "1") {
    // THUMBNAIL mode: the page fills the frame edge to edge — no paper
    // margins, no shadow, no print bar — so the card's scaled preview has
    // zero whitespace.
    html = html.replace(
      "</head>",
      `<style>body{background:#FCFBF9 !important}.page{margin:0 !important;width:100% !important;min-height:auto !important;box-shadow:none !important}.printbar{display:none !important}</style></head>`,
    )
  }
  return new NextResponse(html, { headers })
}
