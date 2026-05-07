import Link from "next/link"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { AlertTriangle, ArrowRight } from "lucide-react"
import { createAnon } from "@/lib/supabase/anon"
import { ClearStaleDriftButton, ResolveDriftButton } from "./SyncIssuesActions"

export const dynamic = "force-dynamic"

interface DriftRow {
  id: string
  detected_at: string
  entity_type: string
  entity_id: string
  kind: string
  severity: string
  cache_state: Record<string, unknown> | null
  qbo_state: Record<string, unknown> | null
  resolution: string | null
}

interface InvoiceRow {
  qbo_invoice_id: string
  doc_number: string | null
  customer_name: string | null
  sync_state: string
  sync_state_changed_at: string
  total_amt: number | null
  balance: number | null
  billing_status: string | null
}

interface ExpectationRow {
  id: string
  entity_type: string
  entity_id: string
  triggered_at: string
  expected_by: string
  source: string | null
  status: string
}

function fmtAge(iso: string) {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m ago`
  return `${Math.floor(h / 24)}d ${h % 24}h ago`
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export default async function SyncIssuesPage() {
  // Two clients: one for `public` (views), one for `billing` (raw tables).
  const publicSb = createAnon("public")
  const billingSb = createAnon("billing")

  const [summaryRes, driftRes, stuckRes, expectRes, probRes] = await Promise.all([
    publicSb.from("v_sync_issues_summary").select("*").single(),
    billingSb
      .from("drift_log")
      .select("id, detected_at, entity_type, entity_id, kind, severity, cache_state, qbo_state, resolution")
      .or("resolution.is.null,resolution.eq.flagged_for_review")
      .order("detected_at", { ascending: false })
      .limit(50),
    billingSb
      .from("invoices")
      .select("qbo_invoice_id, doc_number, customer_name, sync_state, sync_state_changed_at, total_amt, balance, billing_status")
      .in("sync_state", ["pending", "awaiting_propagation"])
      .lt("sync_state_changed_at", new Date(Date.now() - 2 * 60_000).toISOString())
      .order("sync_state_changed_at", { ascending: true })
      .limit(50),
    billingSb
      .from("webhook_expectations")
      .select("id, entity_type, entity_id, triggered_at, expected_by, source, status")
      .eq("status", "missing")
      .gt("triggered_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
      .order("triggered_at", { ascending: false })
      .limit(50),
    billingSb
      .from("invoices")
      .select("qbo_invoice_id, doc_number, customer_name, sync_state, sync_state_changed_at, total_amt, balance, billing_status")
      .in("sync_state", ["sync_failed", "drift_detected"])
      .order("sync_state_changed_at", { ascending: false })
      .limit(50),
  ])

  const summary = (summaryRes.data ?? {
    invoice_problems: 0,
    invoice_stuck_pending: 0,
    missing_webhooks_24h: 0,
    unresolved_drift: 0,
  }) as {
    invoice_problems: number
    invoice_stuck_pending: number
    missing_webhooks_24h: number
    unresolved_drift: number
  }

  const drift = (driftRes.data ?? []) as DriftRow[]
  const stuck = (stuckRes.data ?? []) as InvoiceRow[]
  const expect = (expectRes.data ?? []) as ExpectationRow[]
  const problems = (probRes.data ?? []) as InvoiceRow[]

  // Resolve qbo_invoice_id -> wo_number for everything we might link out to.
  // Many invoices in the cache have no WO link (test data, customer-only
  // invoices) — those rows just don't get an Open button.
  const allInvoiceIds = Array.from(
    new Set([
      ...drift.filter((d) => d.entity_type === "Invoice").map((d) => d.entity_id),
      ...stuck.map((r) => r.qbo_invoice_id),
      ...problems.map((r) => r.qbo_invoice_id),
    ]),
  )
  const woMap = new Map<string, string>()
  if (allInvoiceIds.length > 0) {
    const { data: woRows } = await publicSb
      .from("work_orders")
      .select("wo_number, qbo_invoice_id")
      .in("qbo_invoice_id", allInvoiceIds)
    for (const r of (woRows ?? []) as Array<{ wo_number: string; qbo_invoice_id: string }>) {
      woMap.set(r.qbo_invoice_id, r.wo_number)
    }
  }

  return (
    <>
      <ObjectHeader
        eyebrow="Admin"
        title="Sync issues"
        sub="Drift, stuck syncs, and missing webhooks across the billing pipeline."
        icon={<AlertTriangle className="w-6 h-6" strokeWidth={1.8} />}
      />

      <div className="px-7 py-6 space-y-6 max-w-6xl">
        {/* Summary tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryTile label="Invoice problems" count={summary.invoice_problems} tone="coral" />
          <SummaryTile label="Stuck pending" count={summary.invoice_stuck_pending} tone="sun" />
          <SummaryTile label="Missing webhooks (24h)" count={summary.missing_webhooks_24h} tone="sun" />
          <SummaryTile label="Unresolved drift" count={summary.unresolved_drift} tone="coral" />
        </div>

        <SectionInvoices
          title="Invoice problems"
          subtitle="sync_state = sync_failed or drift_detected"
          rows={problems}
          woMap={woMap}
          emptyMsg="No invoices in a failed or drifted state."
        />

        <SectionInvoices
          title="Stuck pending"
          subtitle="sync_state = pending / awaiting_propagation, older than 2 minutes"
          rows={stuck}
          woMap={woMap}
          emptyMsg="No invoices stuck waiting for propagation."
        />

        <SectionDrift rows={drift} woMap={woMap} />

        <SectionExpectations rows={expect} />
      </div>
    </>
  )
}

function SummaryTile({
  label,
  count,
  tone,
}: {
  label: string
  count: number
  tone: "coral" | "sun" | "neutral"
}) {
  const color = count === 0 ? "text-ink-mute" : tone === "coral" ? "text-coral" : "text-sun"
  return (
    <div className="rounded-lg border border-line bg-bg-elev px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute">{label}</div>
      <div className={`mt-1 text-2xl font-mono font-medium ${color}`}>{count}</div>
    </div>
  )
}

function SectionInvoices({
  title,
  subtitle,
  rows,
  woMap,
  emptyMsg,
}: {
  title: string
  subtitle: string
  rows: InvoiceRow[]
  woMap: Map<string, string>
  emptyMsg: string
}) {
  return (
    <Card>
      <CardHeader className="justify-between">
        <div className="flex flex-col gap-0.5">
          <CardTitle>{title}</CardTitle>
          <div className="text-[11px] text-ink-mute">{subtitle}</div>
        </div>
        <Pill tone={rows.length === 0 ? "neutral" : "coral"}>{rows.length}</Pill>
      </CardHeader>
      {rows.length === 0 ? (
        <CardBody className="text-[13px] text-ink-mute">{emptyMsg}</CardBody>
      ) : (
        <div className="divide-y divide-line-soft">
          {rows.map((r) => (
            <div key={r.qbo_invoice_id} className="flex items-center gap-4 px-5 py-3 text-[13px]">
              <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-ink">#{r.doc_number ?? r.qbo_invoice_id}</span>
                  <span className="text-ink-dim truncate">{r.customer_name ?? "—"}</span>
                </div>
                <div className="text-[11px] text-ink-mute mt-0.5">
                  state: <span className="font-mono">{r.sync_state}</span>
                  {" · "}changed {fmtAge(r.sync_state_changed_at)}
                  {r.billing_status && (
                    <>
                      {" · "}billing: <span className="font-mono">{r.billing_status}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="text-right text-[12px] text-ink-dim shrink-0">
                <div className="font-mono">${(r.total_amt ?? 0).toFixed(2)}</div>
                <div className="text-[11px] text-ink-mute">
                  bal ${Number(r.balance ?? 0).toFixed(2)}
                </div>
              </div>
              {woMap.get(r.qbo_invoice_id) ? (
                <Link
                  href={`/work-orders/${woMap.get(r.qbo_invoice_id)}` as never}
                  className="text-cyan hover:underline inline-flex items-center gap-1 text-[12px]"
                >
                  Open <ArrowRight className="w-3 h-3" />
                </Link>
              ) : (
                <span className="text-ink-mute text-[11px]">no WO link</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function SectionDrift({ rows, woMap }: { rows: DriftRow[]; woMap: Map<string, string> }) {
  return (
    <Card>
      <CardHeader className="justify-between">
        <div className="flex flex-col gap-0.5">
          <CardTitle>Drift detected</CardTitle>
          <div className="text-[11px] text-ink-mute">
            Reconciler found cache vs. QBO mismatch. May have self-corrected since.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={rows.length === 0 ? "neutral" : "coral"}>{rows.length}</Pill>
          <ClearStaleDriftButton disabled={rows.length === 0} />
        </div>
      </CardHeader>
      {rows.length === 0 ? (
        <CardBody className="text-[13px] text-ink-mute">No unresolved drift entries.</CardBody>
      ) : (
        <div className="divide-y divide-line-soft">
          {rows.map((d) => {
            const cacheTs = (d.cache_state as Record<string, string> | null)?.qbo_last_updated_time
            const qboTs = (d.qbo_state as Record<string, string> | null)?.qbo_updated
            const wo = d.entity_type === "Invoice" ? woMap.get(d.entity_id) : undefined
            const href = wo ? (`/work-orders/${wo}` as never) : null
            return (
              <div key={d.id} className="flex items-start gap-4 px-5 py-3 text-[13px]">
                <div className="flex flex-col min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Pill tone={d.severity === "critical" ? "coral" : "sun"}>{d.kind}</Pill>
                    <span className="font-mono text-ink">{d.entity_type}#{d.entity_id}</span>
                    <span className="text-ink-mute text-[11px]">
                      detected {fmtAge(d.detected_at)}
                    </span>
                  </div>
                  <div className="text-[11px] text-ink-mute mt-1 font-mono space-y-0.5">
                    {cacheTs && <div>cache.qbo_last_updated_time: {fmtDate(cacheTs)}</div>}
                    {qboTs && <div>qbo.MetaData.LastUpdatedTime: {fmtDate(qboTs)}</div>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {href && (
                    <Link
                      href={href}
                      className="text-cyan hover:underline inline-flex items-center gap-1 text-[12px]"
                    >
                      Open <ArrowRight className="w-3 h-3" />
                    </Link>
                  )}
                  <ResolveDriftButton id={d.id} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function SectionExpectations({ rows }: { rows: ExpectationRow[] }) {
  return (
    <Card>
      <CardHeader className="justify-between">
        <div className="flex flex-col gap-0.5">
          <CardTitle>Missing webhooks (24h)</CardTitle>
          <div className="text-[11px] text-ink-mute">
            We told the system to expect a QBO webhook but it never arrived.
          </div>
        </div>
        <Pill tone={rows.length === 0 ? "neutral" : "sun"}>{rows.length}</Pill>
      </CardHeader>
      {rows.length === 0 ? (
        <CardBody className="text-[13px] text-ink-mute">All expected webhooks landed.</CardBody>
      ) : (
        <div className="divide-y divide-line-soft">
          {rows.map((e) => (
            <div key={e.id} className="flex items-center gap-4 px-5 py-3 text-[13px]">
              <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-ink">
                    {e.entity_type}#{e.entity_id}
                  </span>
                  {e.source && <span className="text-ink-mute text-[11px]">via {e.source}</span>}
                </div>
                <div className="text-[11px] text-ink-mute mt-0.5">
                  triggered {fmtAge(e.triggered_at)} · due by {fmtDate(e.expected_by)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
