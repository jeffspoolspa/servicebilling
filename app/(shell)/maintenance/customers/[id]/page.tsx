import Link from "next/link"
import { notFound } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { formatCurrency } from "@/lib/utils/format"
import { DAY_NAMES, getMaintenanceCustomerDetail, type VisitContextRow } from "../../_lib/views"

export const metadata = { title: "Maintenance · Customer" }
export const dynamic = "force-dynamic"

const STATUS_TONE: Record<VisitContextRow["status"], "cyan" | "sun" | "grass" | "coral" | "neutral"> = {
  scheduled: "cyan",
  in_progress: "sun",
  completed: "grass",
  skipped: "coral",
  canceled: "neutral",
}
const TYPE_TONE: Record<VisitContextRow["visit_type"], "cyan" | "sun" | "grass" | "neutral" | "indigo"> = {
  route: "cyan",
  qc: "indigo",
  makeup: "sun",
  service_call: "sun",
  repair: "sun",
  seasonal: "neutral",
}

export default async function MaintenanceCustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const customerId = Number(id)
  if (!Number.isFinite(customerId)) notFound()
  const detail = await getMaintenanceCustomerDetail(customerId)
  if (!detail) notFound()

  const { customer, service_locations, tasks, schedules, visits, audit } = detail
  const activeSchedules = schedules.filter((s) => s.active && s.task_status === "active")
  const inactiveSchedules = schedules.filter((s) => !s.active || s.task_status !== "active")

  const totalPerVisit = activeSchedules.reduce(
    (s, r) => s + (r.price_per_visit_cents ?? 0),
    0,
  )
  const flatTaskMonthly = new Map<string, number>()
  for (const s of activeSchedules) {
    if (s.billing_method === "flat_rate_monthly" && s.flat_rate_monthly_cents != null) {
      flatTaskMonthly.set(s.task_id, s.flat_rate_monthly_cents)
    }
  }
  const totalFlat = [...flatTaskMonthly.values()].reduce((a, b) => a + b, 0)

  return (
    <div className="px-7 pt-6 pb-10 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/maintenance/customers" className="text-[12px] text-ink-mute hover:text-ink">
          ← Customers
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-[20px]">{customer.display_name ?? "(unknown)"}</h2>
          <div className="text-ink-mute text-[12px] mt-1 flex items-center gap-3">
            {customer.qbo_customer_id && <span className="font-mono">QBO #{customer.qbo_customer_id}</span>}
            {!customer.is_active && <Pill tone="coral">inactive</Pill>}
            {customer.customer_type && <span>{customer.customer_type}</span>}
            {customer.email && <span>{customer.email}</span>}
            {customer.phone && <span>{customer.phone}</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono num text-[18px] text-ink">
            {formatCurrency(totalPerVisit / 100)}
            <span className="text-[11px] text-ink-mute font-sans ml-1">/ visit</span>
          </div>
          {totalFlat > 0 && (
            <div className="text-[11px] text-ink-mute mt-0.5">
              {formatCurrency(totalFlat / 100)} / mo flat
            </div>
          )}
        </div>
      </div>

      {/* Service locations */}
      <section>
        <h3 className="font-display text-[13px] mb-2">
          Service location{service_locations.length === 1 ? "" : "s"} ({service_locations.length})
        </h3>
        <Card>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-mute border-b border-line-soft">
                <th className="px-4 py-2 font-medium">Address</th>
                <th className="px-4 py-2 font-medium">City</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">ZIP</th>
                <th className="px-4 py-2 font-medium">Primary</th>
              </tr>
            </thead>
            <tbody>
              {service_locations.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-ink-mute">No service locations.</td></tr>
              )}
              {service_locations.map((l) => (
                <tr key={l.id} className="border-b border-line-soft/40 last:border-0">
                  <td className="px-4 py-2 text-ink">{l.street ?? "—"}</td>
                  <td className="px-4 py-2 text-ink-dim">{l.city ?? "—"}</td>
                  <td className="px-4 py-2 text-ink-dim">{l.state ?? "—"}</td>
                  <td className="px-4 py-2 text-ink-dim">{l.zip ?? "—"}</td>
                  <td className="px-4 py-2">{l.is_primary ? <Pill tone="cyan">primary</Pill> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      {/* Tasks */}
      <section>
        <h3 className="font-display text-[13px] mb-2">
          Tasks ({tasks.length})
        </h3>
        <Card>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-mute border-b border-line-soft">
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Service location</th>
                <th className="px-4 py-2 font-medium">Starts</th>
                <th className="px-4 py-2 font-medium">Ends</th>
                <th className="px-4 py-2 font-medium">Pause reason</th>
                <th className="px-4 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-ink-mute">No tasks.</td></tr>
              )}
              {tasks.map((t) => (
                <tr key={t.id} className="border-b border-line-soft/40 last:border-0">
                  <td className="px-4 py-2">
                    <Pill tone={t.status === "active" ? "grass" : t.status === "paused" ? "sun" : "neutral"}>
                      {t.status}
                    </Pill>
                  </td>
                  <td className="px-4 py-2 text-ink-dim">
                    {t.service_location_street ?? "—"}
                    {t.service_location_city && (
                      <span className="text-ink-mute/70">, {t.service_location_city}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-ink-dim font-mono">{t.starts_on}</td>
                  <td className="px-4 py-2 text-ink-dim font-mono">{t.ends_on ?? "—"}</td>
                  <td className="px-4 py-2 text-ink-dim">{t.pause_reason ?? "—"}</td>
                  <td className="px-4 py-2 text-ink-dim text-[11px]">{t.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      {/* Active schedule slots */}
      <section>
        <h3 className="font-display text-[13px] mb-2">
          Active schedule slots ({activeSchedules.length})
        </h3>
        <Card>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-mute border-b border-line-soft">
                <th className="px-4 py-2 font-medium">Day</th>
                <th className="px-4 py-2 font-medium">Tech</th>
                <th className="px-4 py-2 font-medium">Frequency</th>
                <th className="px-4 py-2 font-medium">Office</th>
                <th className="px-4 py-2 font-medium">Billing</th>
                <th className="px-4 py-2 font-medium text-right">Per visit</th>
                <th className="px-4 py-2 font-medium text-right">Flat / mo</th>
                <th className="px-4 py-2 font-medium">ION ID</th>
              </tr>
            </thead>
            <tbody>
              {activeSchedules.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-ink-mute">No active schedules.</td></tr>
              )}
              {activeSchedules.map((s) => (
                <tr key={s.id} className="border-b border-line-soft/40 last:border-0">
                  <td className="px-4 py-2 text-ink">{s.day_of_week != null ? DAY_NAMES[s.day_of_week] : "—"}</td>
                  <td className="px-4 py-2 text-ink-dim">{s.tech_name ?? "—"}</td>
                  <td className="px-4 py-2 text-ink-dim">{s.frequency ?? "—"}</td>
                  <td className="px-4 py-2 text-ink-mute text-[11px] uppercase">{s.office ?? "—"}</td>
                  <td className="px-4 py-2">
                    {s.billing_method === "flat_rate_monthly"
                      ? <Pill tone="sun">flat / mo</Pill>
                      : <span className="text-ink-mute text-[11px]">per visit</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono num text-ink">
                    {s.price_per_visit_cents != null ? formatCurrency(s.price_per_visit_cents / 100) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right font-mono num text-ink-dim">
                    {s.flat_rate_monthly_cents != null ? formatCurrency(s.flat_rate_monthly_cents / 100) : "—"}
                  </td>
                  <td className="px-4 py-2 text-ink-mute text-[11px] font-mono">{s.ion_task_id ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        {inactiveSchedules.length > 0 && (
          <details className="mt-2 text-[11px] text-ink-mute">
            <summary className="cursor-pointer hover:text-ink-dim">
              {inactiveSchedules.length} inactive / closed schedule{inactiveSchedules.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-2 space-y-1 font-mono pl-4">
              {inactiveSchedules.map((s) => (
                <li key={s.id}>
                  {s.day_of_week != null ? DAY_NAMES[s.day_of_week] : "—"} ·{" "}
                  {s.tech_name ?? "no tech"} · {s.frequency ?? "—"} ·{" "}
                  {s.price_per_visit_cents != null ? formatCurrency(s.price_per_visit_cents / 100) : "—"} ·{" "}
                  ion {s.ion_task_id ?? "—"} {!s.active && "(inactive)"} {s.task_status !== "active" && `(${s.task_status})`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* Visit history */}
      <section>
        <h3 className="font-display text-[13px] mb-2">
          Recent visits ({visits.length})
        </h3>
        <Card>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-mute border-b border-line-soft">
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Tech (actual)</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Address</th>
                <th className="px-4 py-2 font-medium text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {visits.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-ink-mute">No visits yet.</td></tr>
              )}
              {visits.map((v) => (
                <tr key={v.id} className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-2 text-ink font-mono">{v.visit_date}</td>
                  <td className="px-4 py-2 text-ink-dim">{v.actual_tech_name ?? "—"}</td>
                  <td className="px-4 py-2"><Pill tone={TYPE_TONE[v.visit_type]} dot>{v.visit_type}</Pill></td>
                  <td className="px-4 py-2"><Pill tone={STATUS_TONE[v.status]} dot>{v.status}</Pill></td>
                  <td className="px-4 py-2 text-ink-dim text-[11px]">{v.service_location_street ?? "—"}</td>
                  <td className="px-4 py-2 text-right font-mono num text-ink">
                    {v.price_cents != null ? formatCurrency(v.price_cents / 100) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      {/* Audit trail */}
      <section>
        <h3 className="font-display text-[13px] mb-2">
          Audit trail ({audit.length})
        </h3>
        <Card>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-mute border-b border-line-soft">
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium">Op</th>
                <th className="px-4 py-2 font-medium">Diff</th>
              </tr>
            </thead>
            <tbody>
              {audit.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-ink-mute">No audit entries yet.</td></tr>
              )}
              {audit.map((a) => (
                <tr key={`${a.kind}-${a.id}`} className="border-b border-line-soft/40 last:border-0 align-top">
                  <td className="px-4 py-2 text-ink-dim font-mono text-[11px] whitespace-nowrap">
                    {new Date(a.changed_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}
                  </td>
                  <td className="px-4 py-2 text-[11px] uppercase tracking-wide text-ink-mute">{a.kind}</td>
                  <td className="px-4 py-2"><Pill tone={a.operation === "INSERT" ? "grass" : a.operation === "DELETE" ? "coral" : "cyan"}>{a.operation}</Pill></td>
                  <td className="px-4 py-2 text-[11px] font-mono text-ink-dim">
                    <DiffSummary diff={a.diff} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>
    </div>
  )
}

function DiffSummary({ diff }: { diff: Record<string, unknown> | null }) {
  if (!diff) return <span className="text-ink-mute">—</span>
  const entries = Object.entries(diff)
  if (entries.length === 0) return <span className="text-ink-mute">(no field changes)</span>
  return (
    <div className="space-y-0.5">
      {entries.slice(0, 6).map(([k, v]) => {
        const change = v as { from?: unknown; to?: unknown }
        return (
          <div key={k}>
            <span className="text-ink">{k}</span>
            : <span className="text-ink-mute">{stringify(change?.from)}</span>
            {" → "}
            <span className="text-cyan">{stringify(change?.to)}</span>
          </div>
        )
      })}
      {entries.length > 6 && <div className="text-ink-mute">+{entries.length - 6} more</div>}
    </div>
  )
}

function stringify(v: unknown): string {
  if (v == null) return "null"
  if (typeof v === "string") return v.length > 40 ? v.slice(0, 40) + "…" : v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return JSON.stringify(v)
}
