import { createSupabaseServer } from "@/lib/supabase/server"
import { MONTHS_SELECT, type MonthOverviewRow } from "../_lib/months"
import { MonthsTable } from "../_components/months-table"

/**
 * The billing months as ONE table of journeys — every customer-month with
 * its progression and current point, filterable by status, clickable into
 * the stage-by-stage detail. No tab-per-status: status is derived from
 * moments, so a single row carries its own history.
 */
export default async function MonthsPage() {
  const sb = await createSupabaseServer()
  const { data, error } = await sb
    .schema("billing")
    .from("v_months_overview")
    .select(MONTHS_SELECT)
    .order("month", { ascending: false })
    .limit(3000)
  if (error) {
    return <div className="p-7 text-sm text-coral">months read failed: {String(error.message ?? error)}</div>
  }
  return (
    <div className="p-7">
      <MonthsTable rows={(data ?? []) as MonthOverviewRow[]} />
    </div>
  )
}
