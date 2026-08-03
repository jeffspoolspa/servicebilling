import { createSupabaseServer } from "@/lib/supabase/server"
import { MonthSelect } from "./_components/month-select"
import { MonthsTable } from "./_components/months-table"
import { MONTHS_SELECT, type MonthOverviewRow } from "./_lib/months"

export const metadata = { title: "Maintenance · Billing" }
export const dynamic = "force-dynamic"

/**
 * THE billing view (RULED: no tab per status, no stage tabs): one table of
 * customer-month journeys for the picked month — the progression stepper
 * shows where each sits; the detail page holds the rest.
 */
export default async function BillingMonthsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const { month } = await searchParams
  const sb = await createSupabaseServer()

  const { data: monthRows } = await sb
    .schema("billing")
    .from("v_months_overview")
    .select("month")
    .order("month", { ascending: false })
    .limit(1000)
  const months = [...new Set(((monthRows ?? []) as { month: string }[]).map((r) => r.month.slice(0, 7)))].map((m) => ({
    value: m,
    label: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-15T12:00:00Z`)),
  }))
  const selected = month && /^\d{4}-\d{2}$/.test(month) ? month : months[0]?.value

  const { data, error } = await sb
    .schema("billing")
    .from("v_months_overview")
    .select(MONTHS_SELECT)
    .eq("month", `${selected}-01`)
    .limit(3000)
  if (error) {
    return <div className="p-7 text-sm text-coral">months read failed: {String(error.message ?? error)}</div>
  }

  return (
    <div className="p-7 space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="font-display text-[18px]">Billing months</h2>
        {selected && <MonthSelect months={months} value={selected} />}
      </div>
      <MonthsTable rows={(data ?? []) as MonthOverviewRow[]} />
    </div>
  )
}
