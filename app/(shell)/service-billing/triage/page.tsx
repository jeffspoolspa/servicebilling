import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { ListChecks } from "lucide-react"
import { getNeedsReviewTriageQueue } from "@/lib/queries/dashboard"
import { TriageReviewer } from "@/components/billing/triage-reviewer"

export const dynamic = "force-dynamic"

/**
 * Rapid-review mode for the needs_review queue. Loads up to 100 invoices
 * with full WO context and hands the snapshot to the client-side reviewer.
 * The reviewer is keyboard-first (a=approve, s=skip, r=re-run, d=open,
 * Esc=exit) so the user can burn down the queue without clicking into
 * each detail page.
 */
export default async function TriagePage() {
  const rows = await getNeedsReviewTriageQueue(100)

  return (
    <>
      <Topbar
        back
        backFallbackHref="/service-billing/needs-attention"
        crumbs={[
          { label: "Service Billing", href: "/service-billing" },
          { label: "Needs Review", href: "/service-billing/needs-attention" },
          { label: "Triage" },
        ]}
      />
      <ObjectHeader
        eyebrow="Service Billing"
        title="Triage"
        sub={`${rows.length} invoice${rows.length === 1 ? "" : "s"} to review · keyboard-first`}
        icon={<ListChecks className="w-6 h-6" strokeWidth={1.8} />}
      />
      <TriageReviewer rows={rows} />
    </>
  )
}
