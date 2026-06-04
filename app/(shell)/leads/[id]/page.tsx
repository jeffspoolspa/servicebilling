import { notFound } from "next/navigation"
import { UserPlus } from "lucide-react"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { BackButton } from "@/components/shell/back-button"
import { requireModuleAccess } from "@/lib/auth/access"
import { getLeadById, getLeadActivities } from "@/lib/queries/leads"
import { formatDate } from "@/lib/utils/format"
import { statusTone, prettyOffice } from "../ui"
import { LeadActions } from "./lead-actions"

export const dynamic = "force-dynamic"

function s(lead: Record<string, unknown>, key: string): string {
  const v = lead[key]
  return v == null || v === "" ? "—" : String(v)
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requireModuleAccess("leads")
  const canWrite = access.canWrite("leads")
  const { id } = await params

  const detail = await getLeadById(id)
  if (!detail || !detail.lead || detail.error) notFound()
  const lead = detail.lead as Record<string, unknown>
  const activities = await getLeadActivities(id)

  const name =
    s(lead, "display_name") !== "—"
      ? String(lead.display_name)
      : `${lead.last_name ?? ""}, ${lead.first_name ?? ""}`.replace(/^,\s*|,\s*$/g, "") || "Lead"
  const status = String(lead.status ?? "new")
  const onboarding = lead.onboarding as Record<string, unknown> | null

  return (
    <>
      <ObjectHeader
        eyebrow="Lead"
        title={name}
        sub={`${prettyOffice(lead.office as string)} · ${s(lead, "source")} · created ${formatDate(String(lead.created_at))}`}
        icon={<UserPlus />}
        actions={
          <div className="flex items-center gap-2">
            <Pill tone={statusTone(status)}>{status}</Pill>
            {detail.payment_on_file && <Pill tone="grass">Card on file</Pill>}
            <BackButton fallbackHref="/leads" />
          </div>
        }
      />
      <div className="px-7 py-6 grid grid-cols-3 gap-5">
        <div className="col-span-2 flex flex-col gap-5">
          <Card>
            <CardHeader><CardTitle>Contact</CardTitle></CardHeader>
            <Field label="Email" value={s(lead, "email")} />
            <Field label="Phone" value={s(lead, "phone")} />
            <Field label="Billing address" value={[lead.billing_street, lead.billing_city, lead.billing_state, lead.billing_zip].filter(Boolean).join(", ") || "—"} />
            <Field label="QBO customer" value={s(lead, "qbo_customer_id")} />
          </Card>

          <Card>
            <CardHeader><CardTitle>Quote details</CardTitle></CardHeader>
            <Field label="Type" value={s(lead, "type")} />
            <Field label="Visits / week" value={s(lead, "visits_per_week")} />
            <Field label="Quoted / visit" value={lead.quoted_per_visit != null ? `$${Number(lead.quoted_per_visit).toFixed(2)}` : "—"} />
            <Field label="First month deposit" value={lead.first_months_deposit != null ? `$${Number(lead.first_months_deposit).toFixed(2)}` : "—"} />
            <Field label="Pool condition" value={s(lead, "pool_condition")} />
            <Field label="Issue / notes" value={s(lead, "issue_description")} />
            <Field label="Quote channel" value={s(lead, "quote_channel")} />
          </Card>

          {onboarding && (
            <Card>
              <CardHeader><CardTitle>Onboarding</CardTitle></CardHeader>
              <Field label="Status" value={s(onboarding, "status")} />
              <Field label="Payment on file" value={onboarding.payment_on_file ? "Yes" : "No"} />
              <Field label="Preferred start" value={s(onboarding, "preferred_start_date")} />
              <Field label="Service day" value={s(onboarding, "service_day_preference")} />
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
            <div className="p-5 pt-2 flex flex-col gap-3">
              {activities.length === 0 && <div className="text-ink-mute text-sm">No activity recorded yet.</div>}
              {activities.map((a) => (
                <div key={a.id} className="flex gap-3 text-[13px]">
                  <Pill tone={a.activity_type === "note" ? "indigo" : "neutral"}>{a.activity_type}</Pill>
                  <div className="flex-1 min-w-0">
                    <div className="text-ink">{a.description ?? "—"}</div>
                    <div className="text-ink-mute text-xs">
                      {formatDate(a.created_at)}{a.created_by ? ` · ${a.created_by}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="col-span-1">
          {canWrite ? (
            <LeadActions leadId={id} status={status} />
          ) : (
            <Card>
              <CardHeader><CardTitle>Actions</CardTitle></CardHeader>
              <div className="p-5 pt-2 text-ink-mute text-sm">You have read-only access to leads.</div>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-5 py-2.5 border-b border-line-soft last:border-b-0 flex justify-between gap-4 text-[13px]">
      <span className="text-ink-mute">{label}</span>
      <span className="text-ink text-right break-words">{value}</span>
    </div>
  )
}
