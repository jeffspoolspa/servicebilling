import { requireOnboardingStaff } from "@/lib/onboarding/infrastructure/staff-guard"
import { onboardingDb, type OfficeRow } from "@/lib/onboarding/infrastructure/db"
import { loadRefData } from "@/lib/onboarding/application/context"
import { SetupButtons } from "./setup-buttons"

export const dynamic = "force-dynamic"

/** /service/onboarding/setup — onboarding admins: integration status + one-time wiring. */
export default async function SetupPage() {
  await requireOnboardingStaff({ admin: true })
  const db = onboardingDb()
  const ref = await loadRefData(db)
  const env = {
    GOOGLE_SERVICE_ACCOUNT_JSON: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    CALENDLY_PAT: Boolean(process.env.CALENDLY_PAT),
    CALENDLY_WEBHOOK_SIGNING_KEY: Boolean(process.env.CALENDLY_WEBHOOK_SIGNING_KEY),
    "machine token": Boolean(process.env.INVOICE_DRAIN_TOKEN || process.env.WINDMILL_TOKEN),
  }
  const { data: lastEvents } = await db
    .from("events")
    .select("created_at, type, status, error")
    .order("created_at", { ascending: false })
    .limit(15)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-display tracking-tight">Setup</h1>
        <p className="text-ink-dim text-[13px]">
          Live mode is <strong className={ref.settings.liveMode ? "text-grass" : "text-sun"}>{ref.settings.liveMode ? "ON" : "OFF"}</strong>
          {ref.settings.liveMode ? "." : `: email to anyone outside @jeffspoolspa.com goes to ${ref.settings.testRecipient} instead.`}
        </p>
      </div>

      <section className="bg-bg-elev border border-line rounded-lg p-5">
        <h2 className="font-display text-[15px] mb-3">Secrets in the app environment</h2>
        <ul className="text-[13px] grid sm:grid-cols-2 gap-1">
          {Object.entries(env).map(([k, v]) => (
            <li key={k} className={v ? "text-grass" : "text-coral"}>
              {v ? "Set" : "Missing"}: <span className="font-mono">{k}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-bg-elev border border-line rounded-lg p-5">
        <h2 className="font-display text-[15px] mb-3">Offices</h2>
        <table className="w-full text-[13px]">
          <thead className="text-ink-mute text-[11px] uppercase tracking-[0.1em]">
            <tr>
              <th className="text-left py-1">Office</th>
              <th className="text-left">Calendly event types</th>
              <th className="text-left">Follow-up link</th>
              <th className="text-left">Default interviewer</th>
            </tr>
          </thead>
          <tbody>
            {ref.offices.map((o: OfficeRow) => {
              const def = ref.officeStaff.find((l) => l.office_code === o.code && l.form_default)
              return (
                <tr key={o.code} className="border-t border-line-soft">
                  <td className="py-1.5">{o.code} · {o.name}</td>
                  <td>{o.calendly_event_type_uris.length || <span className="text-coral">0</span>}</td>
                  <td className="truncate max-w-[220px]">{o.calendly_scheduling_url ?? <span className="text-coral">not set</span>}</td>
                  <td>{ref.staff.find((s) => s.id === def?.staff_id)?.name ?? "—"}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="text-[12px] text-ink-mute mt-3">
          Staff without a work email (they get no interview emails until it's filled):{" "}
          {ref.staff.filter((s) => s.active && !s.email).map((s) => s.name).join(", ") || "none"}
        </p>
      </section>

      <SetupButtons />

      <section className="bg-bg-elev border border-line rounded-lg p-5">
        <h2 className="font-display text-[15px] mb-3">Recent activity</h2>
        <ul className="text-[12px] font-mono flex flex-col gap-1">
          {(lastEvents ?? []).map((e: { created_at: string; type: string; status: string; error: string | null }, i: number) => (
            <li key={i} className={e.status === "error" ? "text-coral" : "text-ink-dim"}>
              {new Date(e.created_at).toLocaleString("en-US", { timeZone: "America/New_York" })} {e.type} {e.status}
              {e.error ? ` — ${e.error.slice(0, 160)}` : ""}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
