"use client"

import { useMemo } from "react"
import { useLiveServerPage } from "@/lib/hooks/use-live-server-page"

/**
 * Drop-in marker for the WO detail page. Subscribes to the four tables
 * that drive the page so any change (cache refresh, recheck, processing
 * attempt, payment apply) reruns the server component in place.
 *
 * Renders nothing — purely a side-effect installer. Mount once at the
 * top of app/(shell)/work-orders/[id]/page.tsx.
 *
 * NOTE: subscribes to ALL events on these tables, not just for this WO.
 * The hook debounces (350ms) and router.refresh() is cheap on this page,
 * but if you have a lot of unrelated billing activity this could fire
 * more often than strictly needed. If that becomes an issue, we can
 * narrow the subscription with row filters by qbo_invoice_id / wo_number.
 */
export function LiveWorkOrderDetail() {
  const tables = useMemo(
    () => [
      // Invoice cache changes (memo, balance, status, email_status, etc.)
      // → drives Summary, Invoice panel, Pre-processing card.
      { schema: "billing" as const, table: "invoices" },
      // Process attempts (new, status transitions) → drives the timeline.
      { schema: "billing" as const, table: "processing_attempts" },
      // Customer payments (credits applied, balance flow) → drives the
      // applied-payments card + open credits panel.
      { schema: "billing" as const, table: "customer_payments" },
      // WO itself (skip flag, billable override, etc.) → drives WO panel.
      { schema: "public" as const, table: "work_orders" },
      // Customer record — drives the CustomerPaymentPreferenceCard so the
      // current pref + applied state stays live if it's changed elsewhere
      // (e.g. from the customer detail page in another tab).
      { schema: "public" as const, table: "Customers" },
      // The event stream — the History feed AND the live processing pills.
      //
      // Deliberately unfiltered. Half an invoice's history comes from OTHER
      // aggregates naming it as a participant (payment_applied on the payment,
      // charge_captured on the WAL attempt, receipt_sent on the payment), so a
      // filter on aggregate_id would miss exactly the events that matter most.
      // At ~39 events/day system-wide, the 350ms debounce makes the cost of
      // listening to all of them nil.
      //
      // This is also why the mutable tables above stay as they are rather than
      // the page deriving everything from events: an event arriving means
      // something changed, and router.refresh() re-renders the server component
      // with both the new events AND the new facts. No client-side merge, no
      // reconciliation — the append-only stream is only ever the trigger.
      { schema: "billing" as const, table: "events" },
    ],
    [],
  )
  useLiveServerPage(tables)
  return null
}
