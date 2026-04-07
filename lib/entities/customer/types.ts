/**
 * Customer entity — domain type that aggregates the canonical customer record
 * with related rows from billing/service tables.
 *
 * The "table row" type comes from generated Supabase types (lib/db/types.ts).
 * The "entity" type below is wider and is the source of truth for the UI.
 */

export interface Customer {
  // From public.Customers
  id: string
  qbo_customer_id: string | null
  display_name: string
  email: string | null
  phone: string | null
  is_active: boolean
  created_at: string
  updated_at: string

  // From public.service_locations (one-to-many)
  service_locations: ServiceLocation[]

  // From billing.customer_payment_methods (one-to-many, future)
  payment_methods: PaymentMethod[]

  // From billing.customer_billing_preferences (one-to-one, future)
  billing_preferences: BillingPreferences | null

  // Computed
  open_balance: number
  is_autopay: boolean
  last_service_date: string | null
}

export interface ServiceLocation {
  id: string
  customer_id: string
  address: string
  city: string | null
  state: string | null
  zip: string | null
  branch: string | null
}

export interface PaymentMethod {
  id: string
  customer_id: string
  qbo_payment_method_id: string
  type: "card" | "ach" | "check"
  card_brand: string | null
  last_four: string | null
  is_default: boolean
  is_active: boolean
}

export interface BillingPreferences {
  customer_id: string
  default_payment_method: "prepaid" | "run_upon_completion" | "invoice"
  auto_charge: boolean
  notes: string | null
}
