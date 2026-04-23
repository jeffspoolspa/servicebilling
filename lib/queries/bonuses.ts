import { createAnon } from "@/lib/supabase/anon"

/**
 * Monthly bonus calculator.
 *
 * Bonus pool:
 *   - Individual rate: 1% of the tech's bonus-eligible subtotal
 *     Applies to Chance Gilliland, Travis Nelson, Aaron Bass, Grayson Cowan.
 *   - Zach Taylor: 0.3% of Chance + Travis + Aaron Bass combined
 *     (Zach is Back Office; his bonus is indexed to the three CTA techs.)
 *
 * "Bonus-eligible" = the `included_in_bonus` flag on v_revenue_by_month,
 * which itself is a COALESCE of (user override, qbo_class='Service').
 * Users can toggle the override from the WO detail page or WO table.
 */

/** The three Brunswick-Service techs whose combined revenue drives Zach's
 *  bonus AND populate Zach's drilldown target on the dashboard card. */
export const CTA_TECHS = [
  "Chance Gilliland",
  "Travis Nelson",
  "Aaron Bass",
] as const
export const GRAYSON_TECH = "Grayson Cowan"
export const ZACH_TECH = "Zachary Taylor"

export const INDIVIDUAL_RATE = 0.01    // 1%
export const ZACH_RATE = 0.003         // 0.3% of CTA combined

export interface BonusEntry {
  tech: string
  /** Short label used in the UI header */
  displayName: string
  /** The dollar base on which the bonus is computed. For Zach this is
   *  the CTA-combined base, not an individual revenue figure. */
  base: number
  /** Count of bonus-eligible WOs that rolled into `base`. Zero for Zach
   *  since his formula derives from others. */
  wos: number
  /** The decimal rate applied to `base` — 0.01 for the four individual
   *  techs, 0.0003 for Zach. */
  rate: number
  bonus: number
  /** Free-text explanation rendered under Zach's row. */
  note?: string
}

export interface MonthlyBonusesResult {
  /** 'YYYY-MM' */
  month: string
  entries: BonusEntry[]
  /** Grand total of all bonuses paid out this month. */
  total_bonus: number
  /** Sum of all bonus-eligible revenue this month (not just the five
   *  techs) — useful context for the card header. */
  total_eligible_revenue: number
}

export async function getMonthlyBonuses(
  month: string, // 'YYYY-MM'
): Promise<MonthlyBonusesResult> {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`invalid month format: ${month} (expected YYYY-MM)`)
  }

  const sb = createAnon("public")
  const monthStart = `${month}-01`
  const monthEndExclusive = addMonth(monthStart)

  // Page-through fetch of only the fields we need, filtered to the month +
  // bonus-eligible rows. PostgREST caps at 1000/page.
  const PAGE = 1000
  let offset = 0
  const byTech = new Map<string, { base: number; wos: number }>()
  let totalEligible = 0

  while (true) {
    const { data, error } = await sb
      .from("v_revenue_by_month")
      .select("tech, sub_total")
      .gte("month", monthStart)
      .lt("month", monthEndExclusive)
      .eq("included_in_bonus", true)
      .range(offset, offset + PAGE - 1)
    if (error) {
      console.error("getMonthlyBonuses fetch error:", error)
      break
    }
    if (!data || data.length === 0) break
    for (const r of data as Array<{ tech: string; sub_total: number }>) {
      const sub = Number(r.sub_total ?? 0)
      totalEligible += sub
      const cur = byTech.get(r.tech) ?? { base: 0, wos: 0 }
      cur.base += sub
      cur.wos += 1
      byTech.set(r.tech, cur)
    }
    if (data.length < PAGE) break
    offset += PAGE
  }

  const chance = byTech.get("Chance Gilliland") ?? { base: 0, wos: 0 }
  const travis = byTech.get("Travis Nelson") ?? { base: 0, wos: 0 }
  const aaron = byTech.get("Aaron Bass") ?? { base: 0, wos: 0 }
  const grayson = byTech.get(GRAYSON_TECH) ?? { base: 0, wos: 0 }
  const ctaCombined = chance.base + travis.base + aaron.base

  const entries: BonusEntry[] = [
    bonusOf("Chance Gilliland", "Chance", chance, INDIVIDUAL_RATE),
    bonusOf("Travis Nelson", "Travis", travis, INDIVIDUAL_RATE),
    bonusOf("Aaron Bass", "Aaron", aaron, INDIVIDUAL_RATE),
    bonusOf(GRAYSON_TECH, "Grayson", grayson, INDIVIDUAL_RATE),
    {
      tech: ZACH_TECH,
      displayName: "Zach",
      base: ctaCombined,
      wos: 0,
      rate: ZACH_RATE,
      bonus: ctaCombined * ZACH_RATE,
      note: "0.3% of Chance + Travis + Aaron combined",
    },
  ]

  const total_bonus = entries.reduce((a, e) => a + e.bonus, 0)

  return {
    month,
    entries,
    total_bonus,
    total_eligible_revenue: totalEligible,
  }
}

function bonusOf(
  tech: string,
  displayName: string,
  agg: { base: number; wos: number },
  rate: number,
): BonusEntry {
  return {
    tech,
    displayName,
    base: agg.base,
    wos: agg.wos,
    rate,
    bonus: agg.base * rate,
  }
}

function addMonth(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  d.setUTCMonth(d.getUTCMonth() + 1)
  return d.toISOString().slice(0, 10)
}

/** Default month for the UI — current month as 'YYYY-MM'. */
export function currentMonthIso(now: Date = new Date()): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, "0")
  return `${y}-${m}`
}

/** Last N months as 'YYYY-MM', most recent first. */
export function recentMonths(n: number, now: Date = new Date()): string[] {
  const out: string[] = []
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  for (let i = 0; i < n; i++) {
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, "0")
    out.push(`${y}-${m}`)
    d.setUTCMonth(d.getUTCMonth() - 1)
  }
  return out
}
