import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Users } from "lucide-react"
import Link from "next/link"
import { listCustomers } from "@/lib/queries/dashboard"

export const dynamic = "force-dynamic"

export default async function CustomersPage() {
  const rows = await listCustomers({ limit: 100 })
  return (
    <>
      <Topbar crumbs={[{ label: "Customers" }]} />
      <ObjectHeader
        eyebrow="Entity"
        title="Customers"
        sub={`Showing ${rows.length} customers`}
        icon={<Users className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6">
        <Card>
          <CardHeader>
            <CardTitle>All Customers</CardTitle>
            <Pill className="ml-auto">{rows.length}</Pill>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-ink-mute border-b border-line-soft bg-[#0c1926]">
                  <th className="px-5 py-2.5 font-medium">QBO ID</th>
                  <th className="font-medium">Name</th>
                  <th className="font-medium">Email</th>
                  <th className="font-medium">Phone</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-line-soft hover:bg-white/[0.03] transition-colors"
                  >
                    <td className="px-5 py-2.5 font-mono text-ink-mute text-xs">
                      {c.qbo_customer_id}
                    </td>
                    <td>
                      <Link
                        href={`/customers/${c.id}` as never}
                        className="text-cyan hover:underline"
                      >
                        {c.display_name}
                      </Link>
                    </td>
                    <td className="text-ink-dim text-xs">{c.email ?? "—"}</td>
                    <td className="text-ink-mute text-xs font-mono">{c.phone ?? "—"}</td>
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
