import { Card } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { listAutopayCustomers } from "../_lib/queries"

export const metadata = { title: "Maintenance · Billing · Autopay" }
export const dynamic = "force-dynamic"

const STATUS_TONE: Record<string, "grass" | "coral" | "sun" | "neutral"> = {
  good: "grass",
  declined: "coral",
  hold: "sun",
}

/** The autopay roster (billing.autopay_customers): who is enrolled and the
 *  card/ACH their monthly charge hits. */
export default async function AutopayRosterPage() {
  const roster = await listAutopayCustomers()
  const active = roster.filter((r) => r.is_active !== false)
  const good = active.filter((r) => r.payment_status === "good").length

  return (
    <div className="px-7 pt-5 pb-10 space-y-4">
      <div>
        <h2 className="font-display text-[16px]">Autopay roster</h2>
        <div className="text-ink-mute text-[12px] mt-0.5">
          {active.length} enrolled · {good} in good standing ·{" "}
          {active.length - good} with payment issues
        </div>
      </div>

      <Card>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">Payment method</th>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium text-right">Declines</th>
            </tr>
          </thead>
          <tbody>
            {active.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-ink-mute">
                  No autopay enrollments.
                </td>
              </tr>
            )}
            {active.map((r) => (
              <tr
                key={r.qbo_customer_id}
                className="border-b border-line-soft/40 last:border-0 hover:bg-white/[0.02]"
              >
                <td className="px-4 py-2.5 text-ink">{r.customer_name ?? "—"}</td>
                <td className="px-4 py-2.5 text-ink-dim">
                  {r.payment_method === "ach"
                    ? "ACH"
                    : `${r.card_type ?? "card"} ····${r.last_four ?? "?"}`}
                </td>
                <td className="px-4 py-2.5 text-ink-mute text-[11px]">{r.email ?? "—"}</td>
                <td className="px-4 py-2.5">
                  <Pill tone={STATUS_TONE[r.payment_status ?? ""] ?? "neutral"} dot>
                    {r.payment_status ?? "unknown"}
                  </Pill>
                </td>
                <td className="px-4 py-2.5 text-right font-mono num text-ink-dim">
                  {r.consecutive_declines ?? 0}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
