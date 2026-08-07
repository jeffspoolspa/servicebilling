import type { Generated } from "kysely"

/**
 * Table types for the tables the new machine touches — HAND-WRITTEN, which
 * is enumerated debt: kysely-codegen replaces this file the day the worker
 * tier lands with a DATABASE_URL (no direct pg credentials exist in the app
 * env today, deliberately). Until then: columns verified against the live
 * information_schema on 2026-08-06; if a query here disagrees with the DB,
 * regenerate — never patch by loosening a type.
 *
 * NOTE pg returns numerics as STRINGS ("1559.01") — model them as string,
 * convert at the repository. Typing them number is how the "balance" >
 * comparisons silently lied all July.
 */

export interface CustomerPaymentMethodsTable {
  id: Generated<string>
  qbo_customer_id: string
  qbo_payment_method_id: string
  type: "credit_card" | "ach"
  card_brand: string | null
  last_four: string
  is_default: boolean // legacy projection — trigger-maintained during the window; NEVER read by new code
  is_active: boolean
  raw: unknown
  fetched_at: Generated<string>
  qbo_created_at: string | null
  auto_disabled_at: string | null
  auto_disabled_reason: string | null
  auto_disabled_after_attempt_id: string | null
  deactivated_at: string | null
  deactivated_by: string | null
}

export interface ChargesTable {
  id: Generated<number>
  charge_id: string | null
  customer_payment_method_id: string | null
  qbo_invoice_id: string | null
  qbo_payment_id: string | null
  status: string
  amount: string // numeric → string
  attempted_at: string | null
  idempotency_key: string | null
  error_message: string | null
}

export interface EventsTable {
  seq: Generated<number>
  occurred_at: string
  aggregate: string
  aggregate_id: string
  type: string
  actor: string
  participants: string[]
  payload: unknown
}

export interface CustomersTable {
  qbo_customer_id: string
  preferred_payment_type: string | null
  pm_last_checked_at: string | null
}

export interface Database {
  "billing.customer_payment_methods": CustomerPaymentMethodsTable
  "billing.charges": ChargesTable
  "billing.events": EventsTable
  Customers: CustomersTable
}
