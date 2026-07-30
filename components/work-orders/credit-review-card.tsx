"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  Coins,
  AlertCircle,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { CreditDecision, OpenCredit } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"

/**
 * Credit review card (derived readiness v3).
 *
 * UNDECIDED derives live: open credits for the customer minus credits with a
 * terminal decision (applied/rejected) on this invoice — nothing is stored
 * for being undecided. Decision rows are append-only events:
 *   proposed  matcher recommendation (reason badge) — still undecided
 *   applied   applied in QBO (auto WO-match, manual, or via review)
 *   rejected  decided not applicable here
 * ('candidate'/'stale' appear only on legacy rows.)
 *
 * Deciding the last undecided credit auto-enqueues the charge via
 * trg_enqueue_charge_on_decision + billing.invoice_ready(); the charge worker
 * re-verifies at claim. "Complete review" rejects everything still undecided.
 */

interface Props {
  qboInvoiceId: string
  balance: number
  credits: OpenCredit[]
  decisions: CreditDecision[]
  /** When review was last completed/overridden (informational). */
  overriddenAt: string | null
}

const TERMINAL = new Set(["applied", "rejected", "stale"])

export function CreditReviewCard({
  qboInvoiceId,
  balance,
  credits,
  decisions,
  overriddenAt,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [completeOpen, setCompleteOpen] = useState(false)
  const [completeNote, setCompleteNote] = useState("")
  const router = useRouter()
  const [, startTransition] = useTransition()

  // Derived: open credits without a terminal decision are undecided.
  const terminal = decisions.filter((d) => TERMINAL.has(d.state))
  const terminalIds = new Set(terminal.map((d) => d.credit_id))
  const recommendationByCredit = new Map(
    decisions
      .filter((d) => d.state === "proposed" || d.state === "candidate")
      .map((d) => [d.credit_id, d]),
  )
  const undecided = credits.filter((c) => !terminalIds.has(c.qbo_payment_id))

  if (undecided.length === 0 && terminal.length === 0) return null

  async function post(url: string, body: unknown, key: string) {
    setBusy(key)
    setErr(null)
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      startTransition(() => router.refresh())
    } catch (e) {
      setErr(e instanceof Error ? e.message : "request failed")
    } finally {
      setBusy(null)
    }
  }

  const applyCredit = (id: string) =>
    post(`/api/billing/invoices/${qboInvoiceId}/apply-credit`, { credit_id: id }, `apply:${id}`)
  const rejectCredit = (id: string) =>
    post(`/api/billing/invoices/${qboInvoiceId}/reject-credit`, { credit_id: id }, `reject:${id}`)
  const completeReview = async () => {
    await post(
      `/api/billing/invoices/${qboInvoiceId}/complete-credit-review`,
      { note: completeNote || null },
      "complete",
    )
    setCompleteOpen(false)
    setCompleteNote("")
  }

  const undecidedTotal = undecided.reduce((a, c) => a + Number(c.unapplied_amt ?? 0), 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Credit review</CardTitle>
        {undecided.length > 0 ? (
          <span className="ml-auto text-[11px] text-sun">
            {undecided.length} to decide · {formatCurrency(undecidedTotal)}
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-grass">
            <CheckCircle2 className="w-3 h-3" strokeWidth={2.5} />
            settled
            {overriddenAt ? ` ${new Date(overriddenAt).toLocaleDateString()}` : ""}
          </span>
        )}
      </CardHeader>
      <CardBody className="text-sm space-y-3">
        {undecided.length > 0 && (
          <div className="rounded-md border border-sun/30 bg-sun/[0.05] px-3 py-2 text-[12px] flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 text-sun flex-shrink-0 mt-0.5" strokeWidth={2} />
            <div className="text-ink-dim leading-relaxed">
              {undecided.length} credit{undecided.length === 1 ? "" : "s"} to decide before
              this invoice can process. Deciding the last one queues it automatically.
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-ink-mute border-b border-line-soft">
                <th className="pb-1.5 pr-2 font-medium">Type</th>
                <th className="pb-1.5 pr-2 font-medium">Ref</th>
                <th className="pb-1.5 pr-2 font-medium">Date</th>
                <th className="pb-1.5 pr-2 font-medium">Match</th>
                <th className="pb-1.5 pr-2 text-right font-medium num">Unapplied</th>
                <th className="pb-1.5 pr-2 font-medium">Outcome</th>
                <th className="pb-1.5 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {/* undecided (derived) — live open credits, recommendation badge
                  when the matcher proposed them */}
              {undecided.map((c) => {
                const rec = recommendationByCredit.get(c.qbo_payment_id)
                const applyAmount = Math.min(Number(c.unapplied_amt ?? 0), balance)
                return (
                  <tr key={c.qbo_payment_id} className="border-b border-line-soft/60 last:border-b-0">
                    <td className="py-2 pr-2 text-ink-dim">
                      {c.type === "credit_memo" ? "Credit memo" : "Payment"}
                    </td>
                    <td className="py-2 pr-2 text-ink-dim font-mono text-[11px]">
                      {c.ref_num ?? "—"}
                    </td>
                    <td className="py-2 pr-2 text-ink-mute text-[11px]">
                      {c.txn_date ? formatDate(c.txn_date) : "—"}
                    </td>
                    <td className="py-2 pr-2 text-[11px]">
                      {rec?.reason ? (
                        <span className="text-cyan" title={`recommended: ${rec.reason}`}>
                          {rec.reason.replace(/_/g, " ")}
                        </span>
                      ) : (
                        <span className="text-ink-mute">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-right num text-sun">
                      {formatCurrency(Number(c.unapplied_amt ?? 0))}
                    </td>
                    <td className="py-2 pr-2">
                      <span className="inline-flex items-center rounded-full border border-sun/30 bg-sun/[0.08] px-2 py-0.5 text-[10px] text-sun">
                        to decide
                      </span>
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <span className="inline-flex gap-1.5">
                        <Button
                          size="sm"
                          variant="default"
                          onClick={() => applyCredit(c.qbo_payment_id)}
                          disabled={busy !== null || applyAmount <= 0}
                          title={
                            applyAmount <= 0
                              ? "Nothing to apply — invoice balance is 0"
                              : `Apply ${formatCurrency(applyAmount)} to this invoice`
                          }
                        >
                          {busy === `apply:${c.qbo_payment_id}` ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Coins className="w-3.5 h-3.5" strokeWidth={2} />
                          )}
                          Apply
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => rejectCredit(c.qbo_payment_id)}
                          disabled={busy !== null}
                          title="Not applicable to this invoice"
                        >
                          {busy === `reject:${c.qbo_payment_id}` ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            "Reject"
                          )}
                        </Button>
                      </span>
                    </td>
                  </tr>
                )
              })}
              {/* history — terminal decision events, never rewritten */}
              {terminal.map((d) => (
                <tr key={`hist-${d.credit_id}`} className="border-b border-line-soft/60 last:border-b-0 opacity-80">
                  <td className="py-2 pr-2 text-ink-dim">
                    {d.credit_type === "credit_memo" ? "Credit memo" : "Payment"}
                  </td>
                  <td className="py-2 pr-2 text-ink-dim font-mono text-[11px]">{d.ref_num ?? "—"}</td>
                  <td className="py-2 pr-2 text-ink-mute text-[11px]">
                    {d.txn_date ? formatDate(d.txn_date) : "—"}
                  </td>
                  <td className="py-2 pr-2 text-[11px]">
                    {d.reason ? (
                      <span className="text-ink-mute">{d.reason.replace(/_/g, " ")}</span>
                    ) : (
                      <span className="text-ink-mute">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-right num text-ink-dim">
                    {formatCurrency(Number(d.amount ?? d.unapplied_at_decision ?? 0))}
                  </td>
                  <td className="py-2 pr-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
                        d.state === "applied"
                          ? "text-grass bg-grass/[0.08] border-grass/30"
                          : "text-ink-mute bg-bg-elev border-line"
                      }`}
                      title={
                        d.state === "applied"
                          ? `applied via ${d.applied_via ?? "—"}`
                          : `by ${d.decided_by ?? "—"}`
                      }
                    >
                      {d.state === "applied" ? (
                        <CheckCircle2 className="w-2.5 h-2.5" strokeWidth={2.5} />
                      ) : (
                        <XCircle className="w-2.5 h-2.5" strokeWidth={2.5} />
                      )}
                      {d.state}
                    </span>
                  </td>
                  <td></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Complete review — rejects everything still undecided */}
        {undecided.length > 0 && (
          <div className="pt-2 border-t border-line-soft">
            {completeOpen ? (
              <div className="space-y-2">
                <div className="text-[11px] text-ink-mute">
                  Rejects the remaining {undecided.length} undecided credit
                  {undecided.length === 1 ? "" : "s"} for this invoice; it queues for
                  processing when every other gate is clean.
                </div>
                <input
                  type="text"
                  value={completeNote}
                  onChange={(e) => setCompleteNote(e.target.value)}
                  placeholder="Reason (optional) — e.g. credit is for WO 4959388"
                  className="w-full bg-bg-elev border border-line rounded-md px-3 py-1.5 text-ink text-sm focus:outline-none focus:border-cyan"
                />
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="primary" onClick={completeReview} disabled={busy !== null}>
                    {busy === "complete" ? "Completing..." : "Confirm"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setCompleteOpen(false)
                      setCompleteNote("")
                    }}
                    disabled={busy !== null}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setCompleteOpen(true)} disabled={busy !== null}>
                Complete review — reject remaining credits
              </Button>
            )}
          </div>
        )}

        {err && (
          <div className="text-[12px] text-coral bg-coral/[0.06] border border-coral/30 rounded-lg px-3 py-2">
            {err}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
