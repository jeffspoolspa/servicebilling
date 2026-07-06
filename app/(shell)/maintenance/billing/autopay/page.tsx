import { listAutopayCandidates, listAutopayCustomers } from "../_lib/queries"
import { AutopayTable } from "../_components/autopay-table"

export const metadata = { title: "Maintenance · Billing · Autopay" }
export const dynamic = "force-dynamic"

/** The autopay roster (billing.autopay_customers): who is enrolled and the
 *  card/ACH their monthly charge hits. Table interactions (search, sort,
 *  status facet, pagination) are client-side in AutopayTable. */
export default async function AutopayRosterPage() {
  const [roster, candidates] = await Promise.all([
    listAutopayCustomers(),
    listAutopayCandidates(),
  ])
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

      <AutopayTable rows={active} candidates={candidates} />
    </div>
  )
}
