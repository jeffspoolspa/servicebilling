import { Card } from "@/components/ui/card"
import { formatCurrency } from "@/lib/utils/format"
import { listActiveTechs } from "../_lib/views"

export const metadata = { title: "Maintenance · Techs" }
export const dynamic = "force-dynamic"

export default async function TechsPage() {
  const techs = await listActiveTechs()

  return (
    <div className="px-7 pt-6 pb-10 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-[16px]">Active maintenance techs</h2>
          <div className="text-ink-mute text-[12px] mt-0.5">
            {techs.length} techs with active route stops
          </div>
        </div>
      </div>

      <Card>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              <th className="px-4 py-2 font-medium">Tech</th>
              <th className="px-4 py-2 font-medium">Department</th>
              <th className="px-4 py-2 font-medium text-right">Active stops</th>
              <th className="px-4 py-2 font-medium text-right">Days/week</th>
              <th className="px-4 py-2 font-medium text-right">Per-cycle revenue</th>
            </tr>
          </thead>
          <tbody>
            {techs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-ink-mute">
                  No active techs found.
                </td>
              </tr>
            )}
            {techs.map((t) => (
              <tr key={t.employee_id} className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]">
                <td className="px-4 py-2.5 text-ink">{t.display_name}</td>
                <td className="px-4 py-2.5 text-ink-dim">{t.department ?? "—"}</td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink">
                  {t.active_task_count}
                </td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
                  {t.days_serviced}
                </td>
                <td className="px-4 py-2.5 text-right font-mono num text-cyan">
                  {formatCurrency((t.total_per_visit_cents ?? 0) / 100)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
