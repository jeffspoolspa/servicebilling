import { readFileSync } from "node:fs"

// TEMP dev-only: render the lead-quote HTML with sample values to preview the design.
// GET /api/comms/preview-quote  → returns the rendered email HTML. Delete after.
export async function GET() {
  let html = readFileSync("lib/comms/lead-quote-email.html", "utf8").replace(/^<!--[\s\S]*?-->\s*/, "")
  const sample: Record<string, string> = {
    customerName: "Carter",
    officeName: "Perfect Pools",
    officePhone: "(912) 459-0160",
    visitFrequency: "Weekly",
    perVisit: "50",
    laborMonthly: "200",
    chemEstimate: "114",
    monthlyTotal: "314",
    monthlyLow: "267",
    monthlyHigh: "375",
    onboardLink: "#",
  }
  html = html.replace(/\{\{\{(\w+)\}\}\}/g, (_m, k) => sample[k] ?? `{{{${k}}}}`)
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
}
