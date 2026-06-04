// Pure lead pricing + service-area helpers — shared by the server intake
// (lib/leads/intake.ts) AND the client form (the live quote + office badge).
// NO "server-only": this must be importable from a client component. Keep it
// free of secrets, DB, and Node APIs. Ported from the website (website-lead-intake).

// ── Service area (ZIP → office) ──────────────────────────────────────────────
const BRUNSWICK_ZIPS = new Set(["31520","31521","31522","31523","31524","31525","31527","31561","31568","31548","31558","31565","31569"])
const RICHMOND_HILL_ZIPS = new Set(["31324","31328","31405","31406","31407","31408","31409","31410","31411","31412","31414","31415","31416","31419","31421","31302","31312","31313","31314","31315","31316","31320","31321","31323","31326","31327","31329","31301","31305","31309","31319","31331","31333"])
const ST_MARYS_ZIPS = new Set(["31547","31558","31548"])

export type Office = "richmond_hill" | "brunswick" | "st_marys"

export function checkServiceArea(zip: string): { inArea: boolean; office: Office | null } {
  const z = (zip || "").trim().slice(0, 5)
  if (BRUNSWICK_ZIPS.has(z)) return { inArea: true, office: "brunswick" }
  if (ST_MARYS_ZIPS.has(z)) return { inArea: true, office: "st_marys" }
  if (RICHMOND_HILL_ZIPS.has(z)) return { inArea: true, office: "richmond_hill" }
  if (z.startsWith("31")) {
    const n = parseInt(z, 10)
    if (n >= 31300 && n <= 31599) return { inArea: true, office: "richmond_hill" }
  }
  return { inArea: false, office: null }
}

// ── Quote (the canonical formula — display == what gets stored) ───────────────
export const BASE_PRICES: Record<string, number> = { pool: 50, spa: 45, fountain: 35 }
export const ADDITIONAL_BODY_SURCHARGE = 10

export function calculateQuote(primaryBodyType: string, additionalBodyCount: number, visitsPerWeek: number) {
  const base = BASE_PRICES[primaryBodyType] ?? 50
  const perVisit = base + additionalBodyCount * ADDITIONAL_BODY_SURCHARGE
  const firstMonthsDeposit = perVisit * visitsPerWeek * 4
  return { perVisit, firstMonthsDeposit }
}
