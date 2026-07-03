import { Card } from "@/components/ui/card"
import { SearchBar } from "@/components/ui/search-bar"
import { SortableHeader } from "@/components/ui/sortable-header"
import { Pill } from "@/components/ui/pill"
import { listAutopayCandidates, listAutopayCustomers } from "../_lib/queries"
import { AutopayAdd, RosterRowActions } from "../_components/autopay-manage"

export const metadata = { title: "Maintenance · Billing · Autopay" }
export const dynamic = "force-dynamic"

const STATUS_TONE: Record<string, "grass" | "coral" | "sun" | "neutral"> = {
  good: "grass",
  declined: "coral",
  hold: "sun",
}

/** The autopay roster (billing.autopay_customers): who is enrolled and the
 *  card/ACH their monthly charge hits. */
export default async function AutopayRosterPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; dir?: string }>
}) {
  const sp = await searchParams
  const [roster, candidates] = await Promise.all([
    listAutopayCustomers(),
    listAutopayCandidates(),
  ])
  const active = roster.filter((r) => r.is_active !== false)
  const good = active.filter((r) => r.payment_status === "good").length
  const q = (sp.q ?? "").trim().toLowerCase()
  const shown = q
    ? active.filter((r) => (r.customer_name ?? "").toLowerCase().includes(q))
    : active

  // URL-driven sort, WO pattern
  const SORT_KEYS = ["customer", "method", "email", "status", "declines"] as const
  type SortKey = (typeof SORT_KEYS)[number]
  const sort: SortKey = SORT_KEYS.includes(sp.sort as SortKey)
    ? (sp.sort as SortKey)
    : "customer"
  const dir: "asc" | "desc" = sp.dir === "desc" ? "desc" : "asc"
  const sortValue = (r: (typeof shown)[number]): string | number => {
    switch (sort) {
      case "customer":
        return (r.customer_name ?? "").toLowerCase()
      case "method":
        return `${r.payment_method ?? ""} ${r.card_type ?? ""} ${r.last_four ?? ""}`
      case "email":
        return (r.email ?? "").toLowerCase()
      case "status":
        return r.payment_status ?? ""
      case "declines":
        return r.consecutive_declines ?? 0
    }
  }
  shown.sort((a, b) => {
    const av = sortValue(a)
    const bv = sortValue(b)
    const cmp =
      typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number)
    return dir === "asc" ? cmp : -cmp
  })
  const preserve = { q: sp.q }

  return (
    <div className="px-7 pt-5 pb-10 space-y-4">
      <div>
        <h2 className="font-display text-[16px]">Autopay roster</h2>
        <div className="text-ink-mute text-[12px] mt-0.5">
          {active.length} enrolled · {good} in good standing ·{" "}
          {active.length - good} with payment issues
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <SearchBar placeholder="Search customer…" className="w-56" />
        <AutopayAdd candidates={candidates} />
      </div>

      <Card>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-ink-mute border-b border-line-soft">
              {(
                [
                  { key: "customer", label: "Customer", align: "left", defaultDir: "asc" },
                  { key: "method", label: "Payment method", align: "left", defaultDir: "asc" },
                  { key: "email", label: "Email", align: "left", defaultDir: "asc" },
                  { key: "status", label: "Status", align: "left", defaultDir: "asc" },
                  { key: "declines", label: "Declines", align: "right", defaultDir: "desc" },
                ] as const
              ).map((col) => (
                <th
                  key={col.key}
                  className={`px-4 py-2 font-medium${col.align === "right" ? " text-right" : ""}`}
                >
                  <SortableHeader
                    label={col.label}
                    column={col.key}
                    currentSort={sort}
                    currentDir={dir}
                    basePath="/maintenance/billing/autopay"
                    preserve={preserve}
                    defaultDir={col.defaultDir}
                    align={col.align}
                  />
                </th>
              ))}
              <th className="px-4 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-ink-mute">
                  No autopay enrollments.
                </td>
              </tr>
            )}
            {shown.map((r) => (
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
                <td className="px-4 py-2.5 text-right">
                  <RosterRowActions qboCustomerId={r.qbo_customer_id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
