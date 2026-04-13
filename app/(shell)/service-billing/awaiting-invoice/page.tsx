import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Tabs } from "@/components/shell/tabs"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { BarChart3 } from "lucide-react"
import Link from "next/link"
import { getBillingQueue } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"

export const dynamic = "force-dynamic"

export default async function AwaitingInvoicePage() {
  const rows = await getBillingQueue({ status: "awaiting_invoice", limit: 200 })
  const total = rows.reduce((acc, r) => acc + Number(r.total_due ?? 0), 0)

  return (
    <>
      <Topbar
        crumbs={[
          { label: "Service Billing", href: "/service-billing" },
          { label: "Awaiting Invoice" },
        ]}
      />
      <ObjectHeader
        eyebrow="Service Billing"
        title="Awaiting Invoice"
        sub={`${rows.length} billable work orders waiting for QBO invoice · ${formatCurrency(total)}`}
        icon={<BarChart3 className="w-6 h-6" strokeWidth={1.8} />}
      />
      <Tabs
        items={[
          { href: "/service-billing/awaiting-invoice", label: "Awaiting Invoice" },
          { href: "/service-billing/queue", label: "Ready to Process" },
          { href: "/service-billing/needs-attention", label: "Needs Review" },
          { href: "/service-billing/sent", label: "Processed" },
        ]}
      />
      <div className="px-7 py-6">
        <Card>
          <CardHeader>
            <CardTitle>Awaiting Invoice</CardTitle>
            <Pill tone="sun" className="ml-auto">{rows.length} · {formatCurrency(total)}</Pill>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-ink-mute border-b border-line-soft bg-[#0c1926]">
                  <th className="px-5 py-2.5 font-medium">WO</th>
                  <th className="font-medium">Invoice #</th>
                  <th className="font-medium">Customer</th>
                  <th className="font-medium">Type</th>
                  <th className="font-medium">Tech</th>
                  <th className="font-medium">Office</th>
                  <th className="font-medium">Completed</th>
                  <th className="font-medium num text-right pr-5">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.wo_number} className="border-b border-line-soft hover:bg-white/[0.03] transition-colors">
                    <td className="px-5 py-2.5 font-mono">
                      <Link href={`/work-orders/${row.wo_number}` as never} className="text-cyan hover:underline">
                        {row.wo_number}
                      </Link>
                    </td>
                    <td className="font-mono text-ink-dim text-xs">{row.invoice_number ?? <span className="text-sun">none</span>}</td>
                    <td className="text-ink truncate max-w-[200px]">{row.customer ?? "—"}</td>
                    <td className="text-ink-dim text-xs">{row.type}</td>
                    <td className="text-ink-mute text-xs font-mono">
                      {row.assigned_to?.split(",")[1]?.trim() ?? row.assigned_to ?? "—"}
                    </td>
                    <td className="text-ink-mute text-xs">{row.office_name}</td>
                    <td className="text-ink-mute text-xs">{formatDate(row.completed)}</td>
                    <td className="num text-right pr-5 text-ink">{formatCurrency(Number(row.total_due ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  )
}
