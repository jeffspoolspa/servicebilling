/**
 * The HIGH BILL EXPLAINER, shared by two doors:
 * - GET  /months/[id]/explainer          — print-faithful HTML, facts only
 * - POST /months/[id]/explainer-generate — the LLM fills the narrative
 *   slots, and the result is persisted to storage at a STABLE path so the
 *   same link survives regeneration.
 *
 * The narrative slots are exactly the reasoning chain Carter ruled
 * (2026-08-04): higher than normal -> must be chemicals (labor is flat per
 * visit) -> which chemicals vs this pool's usual and its peer group ->
 * why they were added (readings/photos) -> a general recommendation that
 * high chemical response usually answers the POOL (possible leak or
 * equipment running inefficiently) and offers a service visit or a
 * treatment-plan consultation.
 */

const MONO = "'IBM Plex Mono', monospace"
const AMBER = "#B8762B"
const INK = "#14171A"
const DIM = "#5C6469"
const FAINT = "#8B9296"
const LINE = "#DDD8D1"

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Target ranges (Carter, 2026-08-07). A CYA of 0 is an UNRECORDED
// reading, never a real zero — callers null it before judging.
function warn(name: string, v: number): boolean {
  if (name === "Free Chlorine") return v < 2 || v > 10
  if (name === "pH") return v < 7.2 || v > 7.8
  if (name === "Total Alkalinity") return v < 60 || v > 120
  if (name === "Calcium Hardness") return v < 200 || v > 400
  if (name === "Cyanuric Acid") return v < 30 || v > 80
  if (name === "Salinity") return v < 2800 || v > 3500
  return false
}

import { OfficeResolver } from "@/lib/comms/office-resolver"

export interface ExplainerNarrative {
  intro?: string
  drivers?: { item: string; note: string }[]
  readings_note?: string
  /** NOTE-DRIVEN (RULED 2026-08-07): what actually went on, written from
   *  the operator's note log — never generic advice. */
  recommendation?: string
  /** Which of the three next steps the note points to. */
  next_step?: "service_call" | "consultation" | "monitor"
}

export interface ExplainerContext {
  monthId: string
  customerId: number
  monthLabel: string
  customerName: string
  thisMonthCents: number
  avgCents: number
  pctOfNormal: number | null
  peerMedianCents: number | null
  peerLine: string
  visits: { visit_date: string; readings: Record<string, string>; chems: { item: string; qty: number }[] }[]
  drivers: { name: string; cents: number; qty: number }[]
  summaryNote: string | null
}

interface Db {
  schema(s: string): { from(t: string): Record<string, (...a: never[]) => unknown> }
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown }>
}

/** Gather the month's facts and render the letter. Returns the context too —
 * it is exactly what the generation prompt gets. */
export async function buildExplainer(
  sys: Db,
  monthId: string,
  narrative?: ExplainerNarrative,
): Promise<{ html: string; context: ExplainerContext } | null> {
  const { data: bmRows } = await (sys.schema("billing").from("billing_months") as never as {
    select(c: string): { eq(k: string, v: string): PromiseLike<{ data: unknown[] | null }> }
  }).select("id, customer_id, month, summary_note").eq("id", monthId)
  const bm = ((bmRows ?? [])[0] ?? null) as { id: string; customer_id: number; month: string; summary_note: string | null } | null
  if (!bm) return null

  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(bm.month.slice(0, 7) + "-15T12:00:00Z"))
  const { data: custRows } = await (sys.schema("public").from("Customers") as never as {
    select(c: string): { eq(k: string, v: unknown): { limit(n: number): PromiseLike<{ data: unknown[] | null }> } }
  }).select("display_name, qbo_customer_id, city").eq("id", bm.customer_id).limit(1)
  const cust = ((custRows ?? [])[0] ?? {}) as { display_name?: string; qbo_customer_id?: string; city?: string | null }
  // RULED 2026-08-07: the LETTER speaks as the office whose techs did the
  // pool the most this month (OfficeResolver.forServiceMonth), geography
  // as the fallback.
  const resolvedBranch = await new OfficeResolver(sys as never).forServiceMonth(bm.customer_id, bm.month, { city: cust.city ?? null })
  const brand = { name: esc(resolvedBranch.brand), phone: resolvedBranch.phone, city: resolvedBranch.city }

  const { data: cpvRows } = await (sys.schema("billing_audit").from("v_customer_month_cpv") as never as {
    select(c: string): { eq(k: string, v: unknown): { limit(n: number): PromiseLike<{ data: unknown[] | null }> } }
  }).select("month, core_usd, specialty_usd, spa_usd, testing_usd, parts_usd, extra_service_usd, discount_usd").eq("customer_id", bm.customer_id).limit(60)
  const byMonth = new Map<string, number>()
  for (const r of (cpvRows ?? []) as { month: string; core_usd: number; specialty_usd: number; spa_usd: number; testing_usd: number; parts_usd: number; extra_service_usd: number; discount_usd: number }[]) {
    byMonth.set(String(r.month).slice(0, 7), Math.round((Number(r.core_usd) + Number(r.specialty_usd) + Number(r.spa_usd) + Number(r.testing_usd) + Number(r.parts_usd) + Number(r.extra_service_usd) + Number(r.discount_usd)) * 100))
  }

  const { data: itemRows } = await (sys.schema("billing").from("billable_items") as never as {
    select(c: string): { eq(k: string, v: unknown): { eq(k2: string, v2: string): { limit(n: number): PromiseLike<{ data: unknown[] | null }> } } }
  }).select("amount_cents, service_date, item_name, qty, kind, billing_month_id").eq("billing_month_id", bm.id).eq("kind", "consumable").limit(5000)
  const hist = ((itemRows ?? []) as { amount_cents: number; service_date: string; item_name: string; qty: number }[])

  const months: string[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(bm.month.slice(0, 10) + "T12:00:00Z")
    d.setUTCMonth(d.getUTCMonth() - i)
    months.push(d.toISOString().slice(0, 7))
  }
  const thisKey = bm.month.slice(0, 7)
  const thisMonthCents = byMonth.get(thisKey) ?? 0
  const priorVals = months.slice(0, 11).map((m) => byMonth.get(m) ?? 0).filter((v) => v > 0)
  const avgCents = priorVals.length ? Math.round(priorVals.reduce((a, b) => a + b, 0) / priorVals.length) : 0
  const pctOfNormal = avgCents > 0 ? Math.round((thisMonthCents / avgCents) * 100) : null

  let peerLine = ""
  let peerMedian: number | null = null
  const { data: peerRows } = await (sys.schema("billing_audit").from("v_customer_month_cpv") as never as {
    select(c: string): { eq(k: string, v: unknown): { limit(n: number): PromiseLike<{ data: unknown[] | null }> } }
  }).select("customer_id, month, peer_group, core_usd, specialty_usd, spa_usd, testing_usd, parts_usd, extra_service_usd, discount_usd").eq("month", bm.month.slice(0, 10)).limit(5000)
  const peers = (peerRows ?? []) as { customer_id: number; peer_group: string; core_usd: number; specialty_usd: number; spa_usd: number; testing_usd: number; parts_usd: number; extra_service_usd: number; discount_usd: number }[]
  const mine = peers.find((p) => p.customer_id === bm.customer_id)
  if (mine) {
    const totals = peers
      .filter((p) => p.peer_group === mine.peer_group)
      .map((p) => p.core_usd + p.specialty_usd + p.spa_usd + p.testing_usd + p.parts_usd + p.extra_service_usd + p.discount_usd)
      .sort((a, b) => a - b)
    if (totals.length >= 5) {
      peerMedian = Math.round(totals[Math.floor(totals.length / 2)] * 100)
      peerLine = `${mine.peer_group.replace(/_/g, " ")} · ${totals.length} pools`
    }
  }

  const catOf = new Map<string, { cents: number; qty: number }>()
  for (const r of hist) {
    const c = catOf.get(r.item_name) ?? { cents: 0, qty: 0 }
    c.cents += r.amount_cents
    c.qty += Number(r.qty)
    catOf.set(r.item_name, c)
  }
  const drivers = [...catOf.entries()]
    .map(([name, v]) => ({ name, cents: v.cents, qty: v.qty }))
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 3)

  const { data: visitRows } = await sys.rpc("maint_billing_review_visits", { p_customer_id: bm.customer_id, p_month: bm.month.slice(0, 10) })
  type V = { visit_date: string; readings: Record<string, string>; chems: { item: string; qty: number }[]; status: string }
  const visits = ((visitRows ?? []) as V[]).filter((v) => v.status === "completed").sort((a, b) => a.visit_date.localeCompare(b.visit_date))

  const READ_COLS: [string, string][] = [["Free Chlorine", "Free Cl"], ["pH", "pH"], ["Total Alkalinity", "TA"], ["Calcium Hardness", "CH"], ["Cyanuric Acid", "CYA"], ["Salinity", "Salt"]]

  const bars = months.map((m2) => byMonth.get(m2) ?? 0)
  const maxBar = Math.max(...bars, 1)

  const noteOf = (name: string) => narrative?.drivers?.find((d) => d.item === name)?.note

  const intro =
    narrative?.intro?.trim() ||
    bm.summary_note?.trim() ||
    `This is not a price change. Your service rate is unchanged. The difference is the volume of chemicals your pool consumed. Here is what was added and what the readings showed.`

  const card = (label: string, value: string, sub: string, accent = false) => `
    <div style="border:1px solid ${LINE};background:#fff;padding:9px 12px;display:flex;flex-direction:column;gap:2px;${accent ? `border-left:4px solid ${AMBER}` : ""}">
      <div style="font-family:${MONO};font-size:9.5px;letter-spacing:0.09em;text-transform:uppercase;color:${DIM}">${label}</div>
      <div style="font-size:24px;font-weight:700;letter-spacing:-0.02em;font-family:${MONO};${accent ? "" : "color:#33393D"}">${value}</div>
      <div style="font-size:12px;color:${accent ? AMBER : DIM};${accent ? "font-weight:600" : ""}">${sub}</div>
    </div>`

  const driverRow = (d: (typeof drivers)[number], last: boolean) => `
    <div style="display:grid;grid-template-columns:1.15fr 0.85fr 2fr;gap:14px;align-items:start;padding-bottom:6px;${last ? "" : `border-bottom:1px solid #E6E2DB`}">
      <div style="display:flex;flex-direction:column;gap:2px">
        <div style="font-size:14.5px;font-weight:600">${esc(d.name)}</div>
        <div style="font-family:${MONO};font-size:11px;color:${DIM}">${Math.round((d.cents / Math.max(1, thisMonthCents)) * 100)}% of this month's chemicals</div>
      </div>
      <div style="font-family:${MONO};font-size:12px;line-height:1.5">
        <div style="color:${AMBER};font-weight:600">${d.qty % 1 ? d.qty.toFixed(1) : d.qty} used</div>
        <div style="color:${DIM}">${usd(d.cents)}</div>
      </div>
      <div style="font-size:13px;line-height:1.4;color:#33393D">${esc(noteOf(d.name) ?? `${usd(d.cents)} of this month's chemicals.`)}</div>
    </div>`

  const readingsRows = visits
    .map((v) => {
      const cells = READ_COLS.map(([name]) => {
        const raw = parseFloat(String(v.readings?.[name] ?? ""))
        const has = isFinite(raw) && (raw !== 0 || name === "Free Chlorine" || name === "pH")
        const bad = has && warn(name, raw)
        return `<td style="text-align:right;padding:3px 0;${bad ? `color:${AMBER};font-weight:600` : ""}">${has ? raw.toLocaleString() : "·"}</td>`
      }).join("")
      const action = (v.chems ?? [])
        .slice(0, 3)
        .map((c) => `${c.qty % 1 ? c.qty.toFixed(1) : c.qty} ${esc(String(c.item ?? "").split(":").pop() ?? "")}`)
        .join(", ")
      const d = new Date(v.visit_date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
      return `<tr style="border-top:1px solid #E6E2DB"><td style="padding:3px 0;color:${DIM}">${d}</td>${cells}<td style="padding:3px 0 3px 16px;font-family:Barlow,sans-serif;font-size:12px">${action || "—"}</td></tr>`
    })
    .join("")

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(cust.display_name ?? "")} · ${monthLabel} · Billing Review</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#e8e6e2; font-family:Barlow, Helvetica, sans-serif; color:${INK}; }
  .page { width:8.5in; min-height:11in; margin:24px auto; background:#FCFBF9; padding:36px 44px 28px; display:flex; flex-direction:column; gap:10px; box-shadow:0 2px 16px rgba(0,0,0,.15); }
  table { width:100%; border-collapse:collapse; font-family:${MONO}; font-size:11.5px; }
  .printbar { position:fixed; top:12px; right:16px; }
  @media print {
    body { background:#FCFBF9; }
    .page { margin:0; box-shadow:none; width:auto; min-height:auto; }
    .printbar { display:none; }
    @page { size: letter; margin: 0; }
  }
</style></head><body>
<div class="printbar"><button onclick="window.print()" style="font:600 13px Barlow;padding:8px 14px;border-radius:8px;border:1px solid #0F3E51;background:#0F3E51;color:#fff;cursor:pointer">Print / Save PDF</button></div>
<section class="page">
  <header style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${INK};padding-bottom:8px">
    <div style="display:flex;flex-direction:column;gap:2px">
      <div style="font-size:19px;font-weight:700;letter-spacing:-0.01em">${brand.name}</div>
      <div style="font-family:${MONO};font-size:10.5px;letter-spacing:0.09em;text-transform:uppercase;color:${DIM}">Water Chemistry &amp; Billing Review</div>
    </div>
    <div style="text-align:right;display:flex;flex-direction:column;gap:2px;font-family:${MONO};font-size:11px;color:${DIM}">
      <div>ACCT ${esc(cust.qbo_customer_id ?? "")} · ${monthLabel}</div>
      <div>${esc(cust.display_name ?? "")}${cust.city ? ` · ${esc(cust.city)}` : ""}</div>
    </div>
  </header>

  <div style="display:flex;flex-direction:column;gap:7px">
    <h1 style="font-size:30px;line-height:1.02;font-weight:700;letter-spacing:-0.02em">${pctOfNormal && pctOfNormal > 130 ? `Your ${monthLabel.split(" ")[0]} chemical charges ran high.` : `Your ${monthLabel.split(" ")[0]} chemistry, reviewed.`}</h1>
    <p style="font-size:13.5px;line-height:1.4;max-width:70ch;color:#33393D">${esc(intro)}</p>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
    ${card("This month", usd(thisMonthCents), pctOfNormal ? `${pctOfNormal}% of your normal` : `${visits.length} visits`, true)}
    ${card("Your 12-month average", avgCents ? usd(avgCents) : "n/a", `${priorVals.length} billed month${priorVals.length === 1 ? "" : "s"}`)}
    ${card("Similar pools nearby", peerMedian != null ? usd(peerMedian) : "n/a", peerLine || "peer group forming")}
  </div>

  <div style="display:flex;flex-direction:column;gap:6px">
    <div style="display:flex;justify-content:space-between;align-items:baseline">
      <div style="font-family:${MONO};font-size:9.5px;letter-spacing:0.09em;text-transform:uppercase;color:${DIM}">Chemical charges, last 12 months</div>
      <div style="font-family:${MONO};font-size:10px;color:${FAINT}">${months[0]} to ${months[11]}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:6px;align-items:end;height:34px">
      ${bars.map((b, i2) => `<div style="height:${Math.max(4, Math.round((b / maxBar) * 100))}%;background:${i2 === 11 ? AMBER : b > avgCents ? "#6FC0EA" : "#CDE8F8"};border-radius:3px 3px 0 0"></div>`).join("")}
    </div>
    <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:6px;font-family:${MONO};font-size:10px;color:${FAINT};text-align:center;line-height:1.45">
      ${months.map((m2, i2) => `<div${i2 === 11 ? ` style="color:${AMBER};font-weight:600"` : ""}>${"JFMAMJJASOND"[Number(m2.slice(5, 7)) - 1]}</div>`).join("")}
    </div>
  </div>

  ${drivers.length > 0 ? `
  <div style="display:flex;flex-direction:column;gap:6px">
    <h2 style="font-size:16px;font-weight:700;letter-spacing:-0.01em;border-bottom:1px solid ${INK};padding-bottom:4px">What drove the difference</h2>
    ${drivers.map((d, i2) => driverRow(d, i2 === drivers.length - 1)).join("")}
  </div>` : ""}

  <div style="display:flex;flex-direction:column;gap:6px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;border-bottom:1px solid ${INK};padding-bottom:4px">
      <h2 style="font-size:16px;font-weight:700;letter-spacing:-0.01em">The readings behind it</h2>
      <div style="font-size:10.5px;color:${DIM};line-height:1.3;text-align:right">Targets: Free Cl 2-10 · pH 7.2-7.8 · TA 60-120 · CH 200-400 · CYA 30-80 · Salt 2,800-3,500 ppm. Amber = out of range.</div>
    </div>
    ${narrative?.readings_note ? `<p style="font-size:13px;line-height:1.45;color:#33393D;max-width:78ch">${esc(narrative.readings_note)}</p>` : ""}
    <table>
      <thead><tr style="color:${DIM};font-size:9.5px;letter-spacing:0.08em;text-transform:uppercase">
        <th style="text-align:left;padding:0 0 4px;font-weight:500">Visit</th>
        ${READ_COLS.map(([, s2]) => `<th style="text-align:right;padding:0 0 4px;font-weight:500">${s2}</th>`).join("")}
        <th style="text-align:left;padding:0 0 4px 16px;font-weight:500">Chemicals added</th>
      </tr></thead>
      <tbody>${readingsRows}</tbody>
    </table>
  </div>

  ${narrative?.recommendation ? (() => {
    const OPTIONS: { key: string; label: string; sub: string }[] = [
      { key: "service_call", label: "Service Call ($135)", sub: "Diagnose suspected equipment issues" },
      { key: "consultation", label: "Consultation", sub: "Review chemistry and outside factors: shade, fill water, animals" },
      { key: "monitor", label: "Monitor", sub: "A fix was made or this looks one-time. We watch how it develops" },
    ]
    const chosen = narrative.next_step ?? "monitor"
    return `
  <div style="display:flex;gap:10px;align-items:stretch">
    <div style="flex:3;display:flex;flex-direction:column;gap:5px;border:1px solid ${LINE};border-left:4px solid #0F3E51;background:#fff;padding:10px 14px">
      <div style="font-family:${MONO};font-size:9.5px;letter-spacing:0.09em;text-transform:uppercase;color:${DIM}">What we recommend</div>
      <p style="font-size:13.5px;line-height:1.45;color:#33393D;max-width:80ch">${esc(narrative.recommendation)}</p>
    </div>
    <div style="flex:2;display:flex;flex-direction:column;gap:6px;border:1px solid ${LINE};background:#fff;padding:10px 12px">
      <div style="font-family:${MONO};font-size:9.5px;letter-spacing:0.09em;text-transform:uppercase;color:${DIM}">Next steps</div>
      ${OPTIONS.map((o) => {
        const on = o.key === chosen
        return `
      <div style="border:1px solid ${on ? "#0F3E51" : LINE};${on ? "background:#EFF6F9;border-left:4px solid #0F3E51;" : "opacity:0.65;"}padding:4px 9px">
        <div style="font-size:11.5px;font-weight:${on ? "700" : "600"};color:#20262B">${o.label}${on ? ` <span style="font-family:${MONO};font-size:8.5px;letter-spacing:0.08em;color:#0F3E51;text-transform:uppercase">· recommended</span>` : ""}</div>
        <div style="font-size:9.5px;line-height:1.35;color:${DIM};margin-top:1px">${o.sub}</div>
      </div>`
      }).join("")}
    </div>
  </div>`
  })() : ""}

  <footer style="margin-top:auto;border-top:1px solid ${LINE};padding-top:8px;display:flex;justify-content:space-between;font-family:${MONO};font-size:10px;color:${FAINT}">
    <div>${brand.name} · ${brand.city}</div>
    <div>Questions? Call ${brand.phone} or reply to your invoice email.</div>
  </footer>
</section>
</body></html>`

  return {
    html,
    context: {
      monthId: bm.id,
      customerId: bm.customer_id,
      monthLabel,
      customerName: cust.display_name ?? "",
      thisMonthCents,
      avgCents,
      pctOfNormal,
      peerMedianCents: peerMedian,
      peerLine,
      visits: visits.map((v) => ({ visit_date: v.visit_date, readings: v.readings, chems: v.chems })),
      drivers,
      summaryNote: bm.summary_note,
    },
  }
}
