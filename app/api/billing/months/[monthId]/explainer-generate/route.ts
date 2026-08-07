import { NextResponse } from "next/server"
import { createSupabaseServer } from "@/lib/supabase/server"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { buildExplainer, type ExplainerNarrative } from "@/lib/billing/application/explainer"
import { generateText, parseJsonReply } from "@/lib/external/llm/narrative"
import { htmlToPdf } from "@/lib/external/pdf/render"

export const maxDuration = 120

/**
 * GENERATE (or regenerate) the month's explainer: context -> the model
 * writes the narrative slots along Carter's reasoning chain -> the letter
 * renders with the narrative -> persisted to storage at the STABLE path
 * explainers/<monthId>.html, so the same link survives regeneration. The
 * summary note is the operator's steering channel — edit it and
 * regenerate. Never touches QBO; attach intent is a separate route.
 */
export async function POST(req: Request, ctx: { params: Promise<{ monthId: string }> }) {
  // Person door or machine door (same token as the drain routes) — the
  // machine door exists so generation can be exercised/automated headless;
  // it writes storage + stamps only, never QBO.
  const machineToken = process.env.INVOICE_DRAIN_TOKEN || process.env.WINDMILL_TOKEN
  const presented = req.headers.get("x-drain-token")
  const machineOk = Boolean(machineToken && presented && presented === machineToken)
  if (!machineOk) {
    const sb = await createSupabaseServer()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const { monthId } = await ctx.params
  const sys = createSupabaseAdmin()

  const base = await buildExplainer(sys as never, monthId)
  if (!base) return NextResponse.json({ error: "month not found" }, { status: 404 })
  const c = base.context

  // The NOTE LOG (RULED 2026-08-05): the request's note appends to the
  // month's chronological log with author + timestamp, and the WHOLE log
  // plus the letter's current narrative rides into the prompt.
  const reqBody = (await req.json().catch(() => ({}))) as { note?: string }
  const { data: bmRow } = await (sys.schema("billing").from("billing_months") as never as {
    select(s: string): { eq(k: string, v: string): PromiseLike<{ data: unknown[] | null }> }
  }).select("month, explainer_notes, explainer_narrative").eq("id", monthId)
  const bmr = ((bmRow ?? [])[0] as { month: string; explainer_notes: { note: string; by: string; at: string }[] | null; explainer_narrative: ExplainerNarrative | null })
  const month = bmr.month.slice(0, 10)
  const notes = [...(bmr.explainer_notes ?? [])]
  const draft = (reqBody.note ?? "").trim()
  if (draft) {
    // Person door has a user; machine door signs as the pipeline.
    let by = "billing_pipeline"
    const sb2 = await createSupabaseServer()
    const { data: { user: u2 } } = await sb2.auth.getUser()
    if (u2?.email) by = u2.email
    notes.push({ note: draft, by, at: new Date().toISOString() })
  }

  const [itemsRes, flagsRes, fuRes] = await Promise.all([
    (sys as never as { rpc(f: string, a: Record<string, unknown>): PromiseLike<{ data: unknown }> })
      .rpc("maint_billing_month_chem_item_summary", { p_customer_id: c.customerId, p_month: month }),
    (sys.schema("billing").from("v_findings_review") as never as {
      select(s: string): { eq(k: string, v: string): { limit(n: number): PromiseLike<{ data: unknown[] | null }> } }
    }).select("message, cents, resolved_at, resolution").eq("billing_month_id", monthId).limit(50),
    (sys.schema("public").from("follow_ups") as never as {
      select(s: string): { eq(k: string, v: unknown): { gte(k2: string, v2: string): { lt(k3: string, v3: string): { limit(n: number): PromiseLike<{ data: unknown[] | null }> } } } }
    }).select("created_at, issue, description, status, next_steps, equipment_off").eq("customer_id", c.customerId)
      .gte("created_at", month).lt("created_at", new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10)).limit(20),
  ])

  const itemCmp = ((itemsRes.data ?? []) as { item_name: string; this_qty: number | null; this_usd: number; self_med_qty: number | null; peer_med_qty: number | null; self_pctl: number | null; peer_pctl: number | null }[])
    .filter((r) => !r.item_name.startsWith("@") && Number(r.this_usd) > 0)
  const flags = (flagsRes.data ?? []) as { message: string; cents: number; resolved_at: string | null }[]
  const followUps = (fuRes.data ?? []) as { created_at: string; issue: string | null; description: string | null; status: string | null; next_steps: string | null; equipment_off: boolean | null }[]

  const prompt = `You are writing the narrative for a pool service company's "high bill explainer" letter to a customer. Facts are below. Follow this exact reasoning chain, but write for a homeowner — plain, warm, factual, no jargon, no blame:
1. The bill was higher than normal for this customer. Labor is flat per visit, so the difference is chemicals.
2. Identify WHICH chemicals drove it, comparing this month's quantities to this pool's own usual amounts and to similar pools (the data below has medians and percentile ranks — p95+ means unusually high).
3. Explain WHY those chemicals were added by pointing at the readings (out-of-range values are the pool asking for treatment).
4. The RECOMMENDATION section is driven ENTIRELY by the operator notes below — they are the technician's actual account of what went on (a found leak, a repair made, an equipment suspicion). Rewrite the notes' story in customer-friendly words as "what went on and what we recommend"; do NOT fall back to generic could-be language when notes exist. Only when there are NO notes, close generally (heavy use often has an underlying cause — offer to help find it).
5. Choose next_step from exactly these three, driven by the notes:
   - "service_call" — equipment issues are suspected and a visit should diagnose them.
   - "consultation" — chemistry/external factors should be reviewed (shade trees, fill water minerals, animals, usage).
   - "monitor" — a fix was recently made and needs time to prove out, or this looks like a one-time spike worth watching.

Keep every claim tied to the numbers given. Do not invent readings or amounts.
Style: plain sentences with commas and periods. NEVER use an em dash or en dash (— or –) anywhere in the output.

FACTS
Customer: ${c.customerName}, month: ${c.monthLabel}
This month's chemicals: $${(c.thisMonthCents / 100).toFixed(2)} — ${c.pctOfNormal ?? "?"}% of their 12-month average ($${(c.avgCents / 100).toFixed(2)}); similar pools' median: ${c.peerMedianCents != null ? `$${(c.peerMedianCents / 100).toFixed(2)}` : "n/a"} (${c.peerLine || "n/a"})
Current letter narrative (the letter as it stands — revise it, don't start over unless the notes ask): ${bmr.explainer_narrative ? JSON.stringify(bmr.explainer_narrative) : "(first generation)"}
Operator notes, chronological — later notes take precedence; fold in, do not quote verbatim:
${notes.length ? notes.map((n) => `[${n.at.slice(0, 10)} ${n.by}] ${n.note}`).join("\n") : "(none)"}
Top items this month: ${c.drivers.map((d) => `${d.name}: ${d.qty} used, $${(d.cents / 100).toFixed(2)}`).join("; ")}
Per-item comparison (qty this month / own median / peer median / own pctl / peer pctl): ${itemCmp.slice(0, 10).map((r) => `${r.item_name}: ${r.this_qty ?? "?"} / ${r.self_med_qty ?? 0} / ${r.peer_med_qty ?? 0} / p${Math.round(Number(r.self_pctl ?? 0))} / p${Math.round(Number(r.peer_pctl ?? 0))}`).join("; ")}
Flagged visits (audit): ${flags.length ? flags.map((f) => `${f.message}${f.resolved_at ? " (reviewed)" : ""}`).join(" | ") : "(none)"}
Readings by visit (a missing value means not recorded that day): ${c.visits.map((v) => `${v.visit_date}: ${Object.entries(v.readings ?? {}).filter(([k, v2]) => Number(v2) !== 0 || k === "Free Chlorine" || k === "pH").map(([k, v2]) => `${k}=${v2}`).join(", ")}`).join(" | ")}
Service follow-ups this month: ${followUps.length ? followUps.map((f) => `${f.created_at.slice(0, 10)} ${f.issue ?? ""}: ${f.description ?? ""}${f.equipment_off ? " (equipment off)" : ""} [${f.status ?? "open"}]${f.next_steps ? ` next: ${f.next_steps}` : ""}`).join(" | ") : "(none)"}

Reply with ONLY a JSON object:
{"intro": "2-3 sentence opening paragraph", "drivers": [{"item": "<exact item name from the top items>", "note": "1-2 sentences on why this item ran high, tied to its comparison numbers"}], "readings_note": "1-2 sentences summarizing what the readings showed", "recommendation": "2-4 sentences written FROM THE OPERATOR NOTES: what actually went on with this pool and what we recommend (customer-friendly, no internal jargon)", "next_step": "service_call" | "consultation" | "monitor"}`

  let narrative: ExplainerNarrative
  try {
    narrative = parseJsonReply<ExplainerNarrative>(await generateText(prompt))
    // The model is told no em/en dashes; scrub any that slip through.
    const scrub = (t: string | undefined) => t?.replace(/\s*[\u2014\u2013]\s*/g, ", ").replace(/,\s*,/g, ",")
    narrative = {
      ...narrative,
      intro: scrub(narrative.intro),
      readings_note: scrub(narrative.readings_note),
      recommendation: scrub(narrative.recommendation),
      drivers: narrative.drivers?.map((d) => ({ ...d, note: scrub(d.note) ?? d.note })),
    }
  } catch (e) {
    return NextResponse.json({ error: `generation failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}` }, { status: 502 })
  }

  const rendered = await buildExplainer(sys as never, monthId, narrative)
  if (!rendered) return NextResponse.json({ error: "month vanished mid-generate" }, { status: 404 })

  // Persist at the stable path — same link forever, regeneration replaces.
  const up = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/explainers/${monthId}.html`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "text/html; charset=utf-8",
      "x-upsert": "true",
    },
    body: rendered.html,
  })
  if (!up.ok) return NextResponse.json({ error: `storage write failed: ${up.status} ${(await up.text()).slice(0, 200)}` }, { status: 502 })

  // The PDF — the artifact downloads hand out and the QBO attach path will
  // upload — rendered right here with serverless chromium, stored beside
  // the HTML at the same stable path. Best-effort: the letter still lands
  // if the render hiccups, and the response says so.
  let pdfOk = false
  try {
    const pdf = await htmlToPdf(rendered.html)
    const up2 = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/explainers/${monthId}.pdf`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/pdf",
        "x-upsert": "true",
      },
      body: new Uint8Array(pdf),
    })
    pdfOk = up2.ok
    if (!up2.ok) console.error(`explainer pdf store failed: ${up2.status}`)
  } catch (e) {
    console.error(`explainer pdf render failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`)
  }

  const stamp = sys.schema("billing").from("billing_months") as never as {
    update(v: Record<string, unknown>): { eq(k: string, v2: string): PromiseLike<{ error: unknown }> }
  }
  const { error: stampErr } = await stamp
    .update({ explainer_generated_at: new Date().toISOString(), explainer_narrative: narrative, explainer_notes: notes })
    .eq("id", monthId)
  if (stampErr) return NextResponse.json({ error: `stamp failed: ${JSON.stringify(stampErr).slice(0, 200)}` }, { status: 500 })

  return NextResponse.json({
    url: `/api/billing/months/${monthId}/explainer-view`,
    narrative,
    notes,
    pdf: pdfOk,
  })
}
