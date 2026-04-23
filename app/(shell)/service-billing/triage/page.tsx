import { getNeedsReviewTriageQueue } from "@/lib/queries/dashboard"
import { TriageReviewer } from "@/components/billing/triage-reviewer"

export const dynamic = "force-dynamic"

/**
 * Rapid-review mode for the needs_review queue. Loads up to 100 invoices
 * with full WO context and hands the snapshot to the client-side reviewer.
 * The reviewer is keyboard-first (a=approve, s=skip, r=re-run, d=open,
 * Esc=exit) so the user can burn down the queue without clicking into
 * each detail page.
 *
 * Topbar / ObjectHeader stripped — shell ModuleHeader covers "where am I"
 * via breadcrumbs. Triage is meant to fill the viewport so the reviewer
 * can focus on a single card at a time. The shared billing layout's KPI
 * strip + tabs still render above; if that proves too cluttered we'll
 * move triage to its own route group.
 */
export default async function TriagePage() {
  const rows = await getNeedsReviewTriageQueue(100)
  return <TriageReviewer rows={rows} />
}
