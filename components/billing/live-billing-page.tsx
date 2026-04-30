"use client"

import { useMemo } from "react"
import { useLiveServerPage } from "@/lib/hooks/use-live-server-page"

/**
 * Drop-in marker that makes the server-rendered billing list pages
 * (queue, needs-attention, etc.) refresh live as their underlying data
 * changes. Renders nothing — purely a side-effect installer.
 *
 * Subscribes to the tables that drive the v_billing_queue view. When any
 * of them change, the page re-runs its server component and the table
 * updates in place.
 */
export function LiveBillingPage() {
  // Stable reference to avoid re-subscribing on every render.
  const tables = useMemo(
    () => [
      { schema: "billing" as const, table: "invoices" },
      { schema: "public" as const, table: "work_orders" },
    ],
    [],
  )
  useLiveServerPage(tables)
  return null
}
