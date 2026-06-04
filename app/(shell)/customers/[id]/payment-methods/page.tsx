import { notFound } from "next/navigation"
import { ObjectHeader } from "@/components/shell/object-header"
import { Tabs } from "@/components/shell/tabs"
import { Users } from "lucide-react"
import { getCustomerById } from "@/lib/queries/dashboard"
import { createAnon } from "@/lib/supabase/anon"
import { requireModuleAccess } from "@/lib/auth/access"
import { PaymentMethodsTable, type PaymentMethodRow } from "./PaymentMethodsTable"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function CustomerPaymentMethodsPage({ params }: PageProps) {
  const { id } = await params
  const access = await requireModuleAccess("service")

  const customer = await getCustomerById(id)
  if (!customer) notFound()

  const rows = customer.qbo_customer_id
    ? await loadPaymentMethods(customer.qbo_customer_id)
    : []

  return (
    <>
      <ObjectHeader
        eyebrow="Customer"
        title={customer.display_name}
        sub={`ID ${customer.id} · QBO ${customer.qbo_customer_id ?? "—"} · ${customer.email ?? "no email"}`}
        icon={<Users className="w-6 h-6" strokeWidth={1.8} />}
      />
      <Tabs
        items={[
          { href: `/customers/${id}`, label: "Overview" },
          { href: `/customers/${id}/invoices`, label: "Invoices" },
          { href: `/customers/${id}/work-orders`, label: "Work Orders" },
          { href: `/customers/${id}/payment-methods`, label: "Payment Methods" },
          { href: `/customers/${id}/billing`, label: "Billing Preferences" },
          { href: `/customers/${id}/notes`, label: "Notes" },
        ]}
      />
      <div className="px-7 py-6 max-w-3xl">
        {!customer.qbo_customer_id && (
          <p className="text-ink-mute text-sm mb-3">
            This customer has no QBO ID linked, so no payment methods can be on file.
          </p>
        )}
        <p className="text-ink-mute text-sm mb-4">
          Cards and ACH accounts mirrored from QBO every 4 hours. Deactivating one
          here makes the billing resolver skip it — the next eligible PM (or email)
          is used instead. Existing invoice payment-method assignments refresh
          automatically. QBO is unaffected.
        </p>
        <PaymentMethodsTable
          rows={rows}
          customerId={id}
          canWrite={access.canWrite("service")}
        />
      </div>
    </>
  )
}

async function loadPaymentMethods(qboCustomerId: string): Promise<PaymentMethodRow[]> {
  const sb = createAnon("billing")
  const { data } = await sb
    .from("customer_payment_methods")
    .select(
      "id, type, card_brand, last_four, is_default, is_active, deactivated_at, fetched_at",
    )
    .eq("qbo_customer_id", qboCustomerId)
    // Active (in QBO) and user-active first; recently-added first within each
    // tier so the row Carter cares about lands near the top.
    .order("is_active", { ascending: false })
    .order("deactivated_at", { ascending: true, nullsFirst: true })
    .order("is_default", { ascending: false })
    .order("fetched_at", { ascending: false })
  return (data ?? []) as PaymentMethodRow[]
}
