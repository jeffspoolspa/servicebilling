import { redirect } from "next/navigation"

/**
 * /service-billing lands on the Awaiting Invoice tab — the entry point of
 * the daily workflow. The shared layout provides the KPI strip + tabs,
 * so the landing page doesn't need its own overview card.
 */
export default function ServiceBillingIndex() {
  redirect("/service-billing/awaiting-invoice" as never)
}
