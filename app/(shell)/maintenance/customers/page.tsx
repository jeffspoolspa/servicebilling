import Link from "next/link"
import { Card } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import { listMaintenanceCustomers } from "../_lib/views"
import { OfficeTabs } from "../_components/office-tabs"

export const metadata = { title: "Maintenance · Customers" }
export const dynamic = "force-dynamic"

const OFFICE_ORDER = ["Brunswick", "Richmond Hill", "St. Marys"] as const

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ office?: string; q?: string }>
}) {
  const { office: filterOffice, q } = await searchParams
  const customers = await listMaintenanceCustomers()

  const officeCounts: Record<string, number> = {}
  for (const c of customers) {
    const o = c.primary_office ?? "Unassigned"
    officeCounts[o] = (officeCounts[o] ?? 0) + 1
  }
  const allOffices = Object.keys(officeCounts).sort((a, b) => {
    const ai = (OFFICE_ORDER as readonly string[]).indexOf(a)
    const bi = (OFFICE_ORDER as readonly string[]).indexOf(b)
    if (ai >= 0 && bi >= 0) return ai - bi
    if (ai >= 0) return -1
    if (bi >= 0) return 1
    return a.localeCompare(b)
  })

  const needle = (q ?? "").trim().toLowerCase()
  const filtered = customers.filter((c) => {
    if (filterOffice && (c.primary_office ?? "Unassigned") !== filterOffice) return false
    if (needle && !(c.display_name ?? "").toLowerCase().includes(needle)) return false
    return true
  })

  const totalPerVisit = filtered.reduce((s, c) => s + c.total_per_visit_cents, 0)
  const totalFlat = filtered.reduce((s, c) => s + c.total_flat_rate_monthly_cents, 0)

  return (
    <>
      <OfficeTabs offices={allOffices} counts={officeCounts} />
      <div className="px-7 pt-6 pb-10 space-y-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-[16px]">
              Active maintenance customers{filterOffice ? ` · ${filterOffice}` : ""}
            </h2>
            <div className="text-ink-mute text-[12px] mt-0.5">
              {filtered.length.toLocaleString()} customers ·{" "}
              {filtered.reduce((s, c) => s + c.active_schedule_count, 0).toLocaleString()} active schedule slots ·{" "}
              {formatCurrency(totalPerVisit / 100)} total per-visit
              {totalFlat > 0 && (
                <> · {formatCurrency(totalFlat / 100)}/mo flat-rate contracts</>
              )}
            </div>
          </div>
          <form className="shrink-0">
            {filterOffice && <input type="hidden" name="office" value={filterOffice} />}
            <input
              type="text"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search by name…"
              className="px-3 py-1.5 text-[13px] bg-white/[0.04] border border-line-soft rounded-md focus:outline-none focus:border-cyan/50 w-64"
            />
          </form>
        </div>

        <Card>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-mute border-b border-line-soft">
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Office</th>
                <th className="px-4 py-2 font-medium text-right">Tasks</th>
                <th className="px-4 py-2 font-medium text-right">Schedule slots</th>
                <th className="px-4 py-2 font-medium text-right">Per visit</th>
                <th className="px-4 py-2 font-medium text-right">Flat / mo</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink-mute">
                    No active maintenance customers for this filter.
                  </td>
                </tr>
              )}
              {filtered.map((c) => (
                <tr key={c.customer_id} className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-2.5 text-ink">
                    <Link
                      href={`/maintenance/customers/${c.customer_id}` as never}
                      className="hover:text-cyan"
                    >
                      {c.display_name ?? <span className="text-ink-mute">(unknown)</span>}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-ink-mute text-[11px] uppercase tracking-wide">
                    {c.primary_office ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono num text-ink">
                    {c.active_task_count}
                    {c.service_location_count > 1 && (
                      <span className="text-[10px] text-ink-mute ml-1">({c.service_location_count} locs)</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono num text-ink">
                    {c.active_schedule_count}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono num text-ink">
                    {formatCurrency(c.total_per_visit_cents / 100)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
                    {c.total_flat_rate_monthly_cents > 0
                      ? formatCurrency(c.total_flat_rate_monthly_cents / 100)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  )
}
