"use client"

import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { createSupabaseBrowser } from "@/lib/supabase/client"

/**
 * Subscribes to Supabase Realtime once per browser session (mounted in the
 * shell layout) and invalidates TanStack Query keys when relevant tables
 * change in the database.
 *
 * The debounce coalesces bursts: a 50-row bulk update produces ~50 Realtime
 * events within a few seconds; we only want to invalidate once per affected
 * query key per debounce window. TanStack Query already de-duplicates
 * concurrent fetches for the same key, so this is belt-and-suspenders, but
 * it also keeps the React DOM from thrashing during big bulk operations.
 *
 * Convention: each table maps to a single TanStack key prefix. Pages that
 * use that data must register their queries with `queryKey: [<prefix>, ...]`
 * for invalidation to reach them.
 *
 * Adding a new table: extend the TABLE_TO_KEY map. Any page using the
 * corresponding key prefix becomes live for free.
 */

interface TableSubscription {
  schema: string
  table: string
  /** TanStack key prefix that pages using this data should use. */
  keyPrefix: string
}

const SUBSCRIPTIONS: TableSubscription[] = [
  // Billing — primary domain
  { schema: "billing", table: "invoices", keyPrefix: "invoices" },
  { schema: "billing", table: "customer_payments", keyPrefix: "payments" },
  { schema: "billing", table: "customer_payment_methods", keyPrefix: "payment-methods" },
  { schema: "billing", table: "processing_attempts", keyPrefix: "processing-attempts" },
  { schema: "billing", table: "drift_log", keyPrefix: "drift-log" },
  { schema: "billing", table: "webhook_expectations", keyPrefix: "webhook-expectations" },

  // Public — work orders, customers, employees
  { schema: "public", table: "work_orders", keyPrefix: "work-orders" },
  { schema: "public", table: "customers", keyPrefix: "customers" },
  { schema: "public", table: "employees", keyPrefix: "employees" },
]

const DEBOUNCE_MS = 250

export function useRealtimeInvalidator() {
  const qc = useQueryClient()

  useEffect(() => {
    const pendingKeys = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      const keys = Array.from(pendingKeys)
      pendingKeys.clear()
      timer = null
      // Always also invalidate the global sync issues summary so the badge
      // count re-renders any time data changes.
      qc.invalidateQueries({ queryKey: ["sync-issues-summary"] })
      for (const k of keys) {
        qc.invalidateQueries({ queryKey: [k] })
      }
    }

    const enqueue = (keyPrefix: string) => {
      pendingKeys.add(keyPrefix)
      if (!timer) timer = setTimeout(flush, DEBOUNCE_MS)
    }

    const sb = createSupabaseBrowser()
    let channel = sb.channel("realtime-invalidator-global")

    for (const sub of SUBSCRIPTIONS) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: sub.schema, table: sub.table },
        () => enqueue(sub.keyPrefix),
      )
    }

    channel.subscribe()

    return () => {
      if (timer) clearTimeout(timer)
      void sb.removeChannel(channel)
    }
  }, [qc])
}
