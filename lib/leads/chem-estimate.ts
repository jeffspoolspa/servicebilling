import "server-only"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import type { ChemEstimates, ChemTier } from "./quote"

/**
 * The ONE place the app reads chemical-cost estimates. Wraps the
 * public.estimate_maint_chemicals(month) RPC (which owns the refinable estimate
 * logic: month pick, frequency mapping, 2x/week derivation) and maps its raw
 * percentile rows to the rounded ChemTier shape the quote engine consumes.
 *
 * Pass a 1-12 month to override; omit to use the DB default (current month).
 * Returns null only on RPC error — callers treat that as "estimate unavailable".
 */
type RawTier = {
  median: number | string
  p25: number | string
  p75: number | string
  sample_size?: number
  approximated?: boolean
} | null

function mapTier(t: RawTier): ChemTier | null {
  if (!t) return null
  return {
    median: Math.round(Number(t.median)),
    low: Math.round(Number(t.p25)),
    high: Math.round(Number(t.p75)),
    sampleSize: t.sample_size,
    approximated: t.approximated,
  }
}

export async function estimateMaintChemicals(month?: number): Promise<ChemEstimates | null> {
  const sb = createSupabaseAdmin()
  const args = month != null ? { p_calendar_month: month } : {}
  const { data, error } = await sb.rpc("estimate_maint_chemicals", args)
  if (error || !data) return null
  const d = data as {
    month: number
    biweekly: RawTier
    weekly: RawTier
    twice_weekly: RawTier
  }
  return {
    month: d.month,
    biweekly: mapTier(d.biweekly),
    weekly: mapTier(d.weekly),
    twiceWeekly: mapTier(d.twice_weekly),
  }
}
