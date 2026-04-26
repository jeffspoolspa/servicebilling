import { createSupabaseServer } from "@/lib/supabase/server"

/**
 * Module-private queries for tables that aren't promoted to entities (yet):
 *   - maintenance.chem_readings
 *   - maintenance.consumables_usage
 *   - maintenance.truck_check_submissions
 *
 * Promote any of these to a real entity folder under lib/entities/ when a
 * second module needs to write to them.
 */

export interface ChemReadingRow {
  id: string
  visit_id: string
  pool_id: string
  ph: number | null
  free_chlorine: number | null
  total_chlorine: number | null
  alkalinity: number | null
  cya: number | null
  salt: number | null
  calcium_hardness: number | null
  captured_at: string
  notes: string | null
}

export async function listChemReadingsForVisit(visitId: string): Promise<ChemReadingRow[]> {
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .schema("maintenance")
    .from("chem_readings")
    .select("*")
    .eq("visit_id", visitId)
    .order("captured_at", { ascending: true })
  return ((data ?? []) as ChemReadingRow[]) ?? []
}

export interface ConsumablesUsageRow {
  id: string
  visit_id: string | null
  pool_id: string | null
  ion_work_order_id: string | null
  item_sku: string | null
  item_id: number | null
  item_name: string | null
  quantity: number | null
  unit: string | null
  source: "ion" | "manual" | "truck_check"
  recorded_at: string
}

export async function listConsumablesForVisit(
  visitId: string,
): Promise<ConsumablesUsageRow[]> {
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .schema("maintenance")
    .from("consumables_usage")
    .select("*")
    .eq("visit_id", visitId)
    .order("recorded_at", { ascending: true })
  return ((data ?? []) as ConsumablesUsageRow[]) ?? []
}

export interface TruckCheckSubmissionRow {
  id: string
  employee_id: string
  submitted_on: string
  items_present: unknown
  items_missing: unknown
  submitted_at: string
}

export async function listTruckCheckSubmissions(opts?: {
  fromDate?: string
  toDate?: string
  employeeId?: string
  limit?: number
}): Promise<TruckCheckSubmissionRow[]> {
  const supabase = await createSupabaseServer()
  let query = supabase
    .schema("maintenance")
    .from("truck_check_submissions")
    .select("*")
    .order("submitted_on", { ascending: false })
    .limit(opts?.limit ?? 200)

  if (opts?.fromDate) query = query.gte("submitted_on", opts.fromDate)
  if (opts?.toDate) query = query.lte("submitted_on", opts.toDate)
  if (opts?.employeeId) query = query.eq("employee_id", opts.employeeId)

  const { data } = await query
  return ((data ?? []) as TruckCheckSubmissionRow[]) ?? []
}
