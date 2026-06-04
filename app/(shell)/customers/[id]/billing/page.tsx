import { notFound } from "next/navigation"
import { Users, CreditCard } from "lucide-react"
import { ObjectHeader } from "@/components/shell/object-header"
import { Tabs } from "@/components/shell/tabs"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { getCustomerById } from "@/lib/queries/dashboard"
import { createAnon } from "@/lib/supabase/anon"
import { requireModuleAccess } from "@/lib/auth/access"
import { formatDate } from "@/lib/utils/format"
import { CustomerPaymentPreferenceCard } from "@/components/work-orders/detail/customer-payment-preference-card"

export const dynamic = "force-dynamic"

type Channel = "email" | "ach" | "credit_card"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function CustomerBillingPreferencesPage({ params }: PageProps) {
  const { id } = await params
  const access = await requireModuleAccess("service")
  const canWrite = access.canWrite("service")

  const customer = await getCustomerById(id)
  if (!customer) notFound()

  const qbo = customer.qbo_customer_id

  const [pref, counts, autopay] = await Promise.all([
    loadServicePreference(id),
    qbo ? loadNeedsReviewCounts(qbo) : Promise.resolve({ candidates: 0, overridden: 0 }),
    qbo ? loadAutopay(qbo) : Promise.resolve(null),
  ])

  const currentPreference = pref ?? null

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

      <div className="px-7 py-6 max-w-2xl space-y-6">
        {/* Service billing */}
        <section className="space-y-2">
          <h2 className="text-ink text-sm font-medium">Service billing</h2>
          {!qbo ? (
            <Note>No QBO ID linked, so there is no preference to set.</Note>
          ) : canWrite ? (
            <CustomerPaymentPreferenceCard
              qboCustomerId={qbo}
              customerName={customer.display_name}
              currentPreference={currentPreference}
              needsReviewCount={counts.candidates}
              needsReviewOverriddenCount={counts.overridden}
            />
          ) : (
            <ReadOnlyServicePreference current={currentPreference} />
          )}
        </section>

        {/* Maintenance billing — sub-section */}
        <section className="space-y-2 pl-3 border-l border-line-soft">
          <h3 className="text-ink-dim text-[13px] font-medium">Maintenance billing (autopay)</h3>
          <MaintenanceAutopayCard autopay={autopay} />
        </section>
      </div>
    </>
  )
}

/* ── presentational ─────────────────────────────────────────────────────── */

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-ink-mute text-sm border border-line-soft rounded-lg p-4 bg-bg-elev/40">
      {children}
    </div>
  )
}

function ReadOnlyServicePreference({ current }: { current: Channel | null }) {
  return (
    <Card>
      <CardHeader className="justify-between">
        <CardTitle>Service payment preference</CardTitle>
        {current ? <Pill tone="cyan">{prefLabel(current)}</Pill> : <Pill tone="neutral">auto</Pill>}
      </CardHeader>
      <CardBody className="text-ink-mute text-[12px]">
        {current
          ? `Service invoices default to ${prefLabel(current)}.`
          : "No explicit preference — invoices auto-derive from the default method on file."}
        <div className="mt-1 text-[11px]">Read-only access — ask an admin to change this.</div>
      </CardBody>
    </Card>
  )
}

function MaintenanceAutopayCard({ autopay }: { autopay: Autopay | null }) {
  if (!autopay || !autopay.is_active) {
    return (
      <Card>
        <CardHeader className="justify-between">
          <CardTitle>Monthly autopay</CardTitle>
          <Pill tone="neutral">not enrolled</Pill>
        </CardHeader>
        <CardBody className="text-ink-mute text-[12px]">
          Not enrolled in maintenance autopay — monthly maintenance invoices are emailed.
        </CardBody>
      </Card>
    )
  }
  const method = autopay.card_type
    ? `${autopay.card_type} ····${autopay.last_four ?? "—"}`
    : autopay.payment_method ?? "method on file"
  const statusTone =
    autopay.payment_status === "active" || autopay.payment_status === "ok"
      ? "grass"
      : autopay.payment_status === "declined"
        ? "coral"
        : "sun"
  return (
    <Card>
      <CardHeader className="justify-between">
        <CardTitle>Monthly autopay</CardTitle>
        <Pill tone="grass">enrolled</Pill>
      </CardHeader>
      <CardBody className="text-[12px] space-y-1.5">
        <div className="flex items-center gap-2 text-ink">
          <CreditCard className="w-3.5 h-3.5 text-ink-dim" strokeWidth={1.8} />
          {method}
        </div>
        <div className="flex items-center gap-2 text-ink-mute">
          <span>Status</span>
          <Pill tone={statusTone}>{autopay.payment_status}</Pill>
          {autopay.enrolled_at && <span>· since {formatDate(autopay.enrolled_at)}</span>}
        </div>
        <div className="text-ink-mute text-[11px]">
          Managed by the monthly maintenance billing run, not the service resolver.
        </div>
      </CardBody>
    </Card>
  )
}

function prefLabel(c: Channel): string {
  if (c === "email") return "Email"
  if (c === "credit_card") return "Credit card"
  return "ACH"
}

/* ── loaders ────────────────────────────────────────────────────────────── */

async function loadServicePreference(localId: string): Promise<Channel | null> {
  const sb = createAnon("public")
  const { data } = await sb
    .from("Customers")
    .select("preferred_payment_type")
    .eq("id", localId)
    .single()
  return (data?.preferred_payment_type ?? null) as Channel | null
}

async function loadNeedsReviewCounts(
  qboCustomerId: string,
): Promise<{ candidates: number; overridden: number }> {
  const sb = createAnon("public")
  const [candidatesRes, overriddenRes] = await Promise.all([
    sb
      .from("billing_invoices")
      .select("*", { count: "exact", head: true })
      .eq("qbo_customer_id", qboCustomerId)
      .eq("billing_status", "needs_review")
      .is("preferred_payment_type_overridden_at", null),
    sb
      .from("billing_invoices")
      .select("*", { count: "exact", head: true })
      .eq("qbo_customer_id", qboCustomerId)
      .eq("billing_status", "needs_review")
      .not("preferred_payment_type_overridden_at", "is", null),
  ])
  return { candidates: candidatesRes.count ?? 0, overridden: overriddenRes.count ?? 0 }
}

interface Autopay {
  is_active: boolean
  payment_status: string
  payment_method: string | null
  card_type: string | null
  last_four: string | null
  enrolled_at: string | null
}

async function loadAutopay(qboCustomerId: string): Promise<Autopay | null> {
  // RLS is disabled on billing.autopay_customers, so the anon client reads it.
  const sb = createAnon("billing")
  const { data } = await sb
    .from("autopay_customers")
    .select("is_active, payment_status, payment_method, card_type, last_four, enrolled_at")
    .eq("qbo_customer_id", qboCustomerId)
    .maybeSingle()
  return (data ?? null) as Autopay | null
}
