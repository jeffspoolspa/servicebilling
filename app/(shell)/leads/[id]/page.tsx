import { notFound } from "next/navigation"
import Link from "next/link"
import { UserPlus, CreditCard, Mail, Phone, MapPin } from "lucide-react"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Button } from "@/components/ui/button"
import { BackButton } from "@/components/shell/back-button"
import { StatusStepper, type Stage } from "@/components/ui/status-stepper"
import { ActivityTimeline, type TimelineType } from "@/components/ui/activity-timeline"
import { StaticMap } from "@/components/form/static-map"
import { requireModuleAccess } from "@/lib/auth/access"
import { getLeadById, getLeadTimeline } from "@/lib/queries/leads"
import { calculateMaintQuote } from "@/lib/leads/quote"
import { estimateMaintChemicals } from "@/lib/leads/chem-estimate"
import { formatDate, formatPhone } from "@/lib/utils/format"
import { prettyOffice } from "../ui"
import { EditCustomerButton } from "./edit-customer-dialog"

export const dynamic = "force-dynamic"

// The derived lead lifecycle. Status is a consequence of what's happened (quote
// sent → quoted, payment on file → converted), never set by hand. Off-ramp states
// (declined/expired/disqualified) render as a terminal chevron by the stepper.
const LEAD_STAGES: Stage[] = [
  { key: "new", label: "New" },
  { key: "quoted", label: "Quoted" },
  { key: "accepted", label: "Accepted" },
  { key: "converted", label: "Converted" },
]

const TIMELINE_TYPES: Record<string, TimelineType> = {
  email: { label: "Email", color: "cyan" },
  text: { label: "Text", color: "teal" },
  other: { label: "Other", color: "neutral" },
}

function s(lead: Record<string, unknown>, key: string): string {
  const v = lead[key]
  return v == null || v === "" ? "—" : String(v)
}
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`

function frequencyLabel(v: number): string {
  if (v === 0.5) return "Bi-weekly"
  if (v >= 2) return `${v}× / week`
  return "Weekly"
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requireModuleAccess("leads")
  const canWrite = access.canWrite("leads")
  const { id } = await params

  const detail = await getLeadById(id)
  if (!detail || !detail.lead || detail.error) notFound()
  const lead = detail.lead as Record<string, unknown>
  const timeline = await getLeadTimeline(id)

  const name =
    s(lead, "display_name") !== "—"
      ? String(lead.display_name)
      : `${lead.last_name ?? ""}, ${lead.first_name ?? ""}`.replace(/^,\s*|,\s*$/g, "") || "Lead"
  const status = String(lead.status ?? "new")
  const onboarding = lead.onboarding as Record<string, unknown> | null

  const address = [lead.billing_street, lead.billing_city, lead.billing_state, lead.billing_zip]
    .filter(Boolean)
    .join(", ")

  const customer = {
    account_id: Number(lead.account_id),
    first_name: String(lead.first_name ?? ""),
    last_name: String(lead.last_name ?? ""),
    email: String(lead.email ?? ""),
    phone: String(lead.phone ?? ""),
    street: String(lead.billing_street ?? ""),
    city: String(lead.billing_city ?? ""),
    state: String(lead.billing_state ?? ""),
    zip: String(lead.billing_zip ?? ""),
  }

  // Quote build-up: per-visit (what they were quoted) → labor monthly → + est.
  // chemicals → estimated monthly. Chemicals come from the canonical estimate.
  const bodies = (lead.bodies as Array<Record<string, unknown>>) ?? []
  const primaryBody = bodies.find((b) => b.is_primary) ?? bodies[0]
  const visits = Number(lead.visits_per_week ?? 1)
  const perVisit = lead.quoted_per_visit != null ? Number(lead.quoted_per_visit) : null
  let chemMedian: number | null = null
  let chemLow: number | null = null
  let chemHigh: number | null = null
  if (primaryBody) {
    const chemEstimates = await estimateMaintChemicals()
    const q = calculateMaintQuote(
      {
        primaryBodyType: String(primaryBody.body_type) as "pool" | "spa" | "fountain",
        additionalBodyCount: Math.max(0, bodies.length - 1),
        visitsPerWeek: visits,
      },
      chemEstimates,
    )
    chemMedian = q.chem?.median ?? null
    chemLow = q.chem?.low ?? null
    chemHigh = q.chem?.high ?? null
  }
  const laborMonthly = perVisit != null ? Math.round(perVisit * visits * 4) : null
  const monthlyMedian = laborMonthly != null ? laborMonthly + (chemMedian ?? 0) : null

  return (
    <>
      <ObjectHeader back
        eyebrow="Lead"
        title={name}
        icon={<UserPlus />}
        sub={
          <div className="flex flex-col gap-1">
            <span>
              {prettyOffice(lead.office as string)} · {s(lead, "source")} · created {formatDate(String(lead.created_at))}
            </span>
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-mute">
              {!!lead.email && (
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-ink-mute" /> {String(lead.email)}
                </span>
              )}
              {!!lead.phone && (
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5 text-ink-mute" /> {formatPhone(String(lead.phone))}
                </span>
              )}
              {address && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-ink-mute" /> {address}
                </span>
              )}
            </span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            {detail.payment_on_file && <Pill tone="grass">Card on file</Pill>}
            {canWrite && <EditCustomerButton leadId={id} customer={customer} />}
            <BackButton fallbackHref="/leads" />
          </div>
        }
      />

      {/* Status bar — derived stepper + the onboard action inline on the right */}
      <div className="px-7 pt-5 flex items-center gap-4">
        <StatusStepper stages={LEAD_STAGES} current={status} className="flex-1" />
        {canWrite && (
          <Link href={`/leads/${id}/onboarding` as never} className="shrink-0">
            <Button type="button" variant="primary" size="md">
              <CreditCard className="w-4 h-4" /> Onboard
            </Button>
          </Link>
        )}
      </div>

      <div className="px-7 py-6 grid grid-cols-3 gap-5">
        {/* Main: activity + (coming) email/text comms */}
        <div className="col-span-2 flex flex-col gap-5">
          <ActivityTimeline items={timeline} types={TIMELINE_TYPES} />
        </div>

        {/* Side: quote build-up + onboarding */}
        <div className="col-span-1 flex flex-col gap-5">
          <Card>
            <CardHeader><CardTitle>Quote details</CardTitle></CardHeader>
            <div className="p-5 pt-2 flex flex-col">
              <Row label="Per visit" value={perVisit != null ? money(perVisit) : "—"} />
              <Row label="Frequency" value={`${frequencyLabel(visits)} (${visits}×/wk)`} />
              <Row label="Labor (monthly)" value={laborMonthly != null ? money(laborMonthly) : "—"} hint={perVisit != null ? `${money(perVisit)} × ${visits} × 4 weeks` : undefined} />
              <Row
                label="Est. chemicals"
                value={chemMedian != null ? money(chemMedian) : "—"}
                hint={chemLow != null && chemHigh != null ? `${money(chemLow)}–${money(chemHigh)}` : undefined}
              />
              <div className="mt-2 pt-3 border-t border-line-soft flex items-baseline justify-between">
                <span className="text-ink font-medium">Estimated monthly</span>
                <span className="text-cyan font-display text-2xl">
                  {monthlyMedian != null ? money(monthlyMedian) : "—"}
                </span>
              </div>
              {chemMedian == null && (
                <p className="text-ink-mute text-[11px] mt-2">Chemical estimate unavailable — labor only.</p>
              )}
            </div>
          </Card>

          {address && (
            <Card>
              <CardHeader><CardTitle>Location</CardTitle></CardHeader>
              <div className="p-3 pt-0">
                <StaticMap address={address} height={150} />
                <p className="px-2 pt-2 text-ink-mute text-[12px] inline-flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" /> {address}
                </p>
              </div>
            </Card>
          )}

          {onboarding && (
            <Card>
              <CardHeader><CardTitle>Onboarding</CardTitle></CardHeader>
              <Row label="Status" value={s(onboarding, "status")} />
              <Row label="Payment on file" value={onboarding.payment_on_file ? "Yes" : "No"} />
              <Row label="Preferred start" value={s(onboarding, "preferred_start_date")} />
              <Row label="Service day" value={s(onboarding, "service_day_preference")} />
            </Card>
          )}
        </div>
      </div>
    </>
  )
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="py-2.5 border-b border-line-soft last:border-b-0 flex justify-between gap-4 text-[13px]">
      <span className="text-ink-mute">{label}</span>
      <span className="text-ink text-right break-words">
        {value}
        {hint && <span className="block text-ink-mute text-[11px] font-normal">{hint}</span>}
      </span>
    </div>
  )
}
