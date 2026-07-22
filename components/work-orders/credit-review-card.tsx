"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  Coins,
  AlertCircle,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { CreditDecision, OpenCredit } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"

/**
 * Credit review card for the WO detail page — the per-invoice CREDIT DECISION
 * RECORD (billing.invoice_credit_decisions): every credit pre-process saw for
 * this invoice, frozen, each ending in an outcome:
 *
 *   candidate  open — decide: Apply or Reject
 *   applied    applied in QBO (auto WO-match, manual, or externally)
 *   rejected   decided not applicable (user or review-complete)
 *   stale      reality moved on (credit consumed elsewhere / invoice settled)
 *
 * "Complete review" closes all remaining candidates as rejected and runs the
 * override machinery — the invoice moves to ready_to_process when every other
 * gate is clean. Credits that arrived AFTER pre-process (no decision row yet)
 * are listed separately; the charge worker's claim-time guard routes the
 * invoice back through pre-process if they're still undecided at charge time.
 */

interface Props {
  qboInvoiceId: string
  balance: number
  credits: OpenCredit[]
  decisions: CreditDecision[]
  /** Whether the user has already overridden/completed credit review. */
  overriddenAt: string | null
}

const STATE_META: Record<
  CreditDecision["state"],
  { label: string; cls: string }
> = {
  candidate: { label: "to decide", cls: "text-sun bg-sun/[0.08] border-sun/30" },
  applied: { label: "applied", cls: "text-grass bg-grass/[0.08] border-grass/30" },
  rejected: { label: "rejected", cls: "text-ink-mute bg-bg-elev border-line" },
  stale: { label: "stale", cls: "text-ink-mute bg-bg-elev border-line" },
}

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

  const candidates = decisions.filter((d) => d.state === "candidate")
  const settled = decisions.filter((d) => d.state !== "candidate")
  // Credits with no decision row: arrived after pre-process ran (or invoice
  // not yet pre-processed). The claim-time guard covers these at charge.
  const decidedIds = new Set(decisions.map((d) => d.credit_id))
  const newSinceReview = credits.filter((c) => !decidedIds.has(c.qbo_payment_id))

  if (decisions.length === 0 && credits.length === 0 && !overriddenAt) return null

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

  async function applyCredit(creditId: string) {
    // apply-credit runs QBO synchronously; on success it also flips the
    // decision row (mark_credit_decision_applied)
    await post(
      `/api/billing/invoices/${qboInvoiceId}/apply-credit`,
      { credit_id: creditId },
      `apply:${creditId}`,
    )
  }

  async function rejectCredit(creditId: string) {
    await post(
      `/api/billing/invoices/${qboInvoiceId}/reject-credit`,
      { credit_id: creditId },
      `reject:${creditId}`,
    )
  }

  async function completeReview() {
    await post(
      `/api/billing/invoices/${qboInvoiceId}/complete-credit-review`,
      { note: completeNote || null },
      "complete",
    )
    setCompleteOpen(false)
    setCompleteNote("")
  }

  const openTotal = candidates.reduce(
    (a, d) => a + Number(d.current_unapplied_amt ?? d.unapplied_at_decision ?? 0),
    0,
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Credit review</CardTitle>
        {overriddenAt && candidates.length === 0 ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-grass">
            <CheckCircle2 className="w-3 h-3" strokeWidth={2.5} />
            review complete {new Date(overriddenAt).toLocaleDateString()}
          </span>
        ) : (
          candidates.length > 0 && (
            <span className="ml-auto text-[11px] text-sun">
              {candidates.length} to decide · {formatCurrency(openTotal)}
            </span>
          )
        )}
      </CardHeader>
      <CardBody className="text-sm space-y-3">
        {decisions.length === 0 && credits.length === 0 ? (
          <div className="text-[12px] text-ink-mute italic">
            No applicable open credits on this customer right now.
          </div>
        ) : (
          <>
            {candidates.length > 0 && (
              <div className="rounded-md border border-sun/30 bg-sun/[0.05] px-3 py-2 text-[12px] flex items-start gap-2">
                <AlertCircle
                  className="w-3.5 h-3.5 text-sun flex-shrink-0 mt-0.5"
                  strokeWidth={2}
                />
                <div className="text-ink-dim leading-relaxed">
                  {candidates.length} credit
                  {candidates.length === 1 ? "" : "s"} to decide before this
                  invoice can process. Apply, reject each, or complete review to
                  reject the rest.
                </div>
              </div>
            )}

            {decisions.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-ink-mute border-b border-line-soft">
                      <th className="pb-1.5 pr-2 font-medium">Type</th>
                      <th className="pb-1.5 pr-2 font-medium">Ref</th>
                      <th className="pb-1.5 pr-2 font-medium">Date</th>
                      <th className="pb-1.5 pr-2 font-medium">Match</th>
                      <th className="pb-1.5 pr-2 text-right font-medium num">
                        Unapplied
                      </th>
                      <th className="pb-1.5 pr-2 font-medium">Outcome</th>
                      <th className="pb-1.5 text-right font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...candidates, ...settled].map((d) => {
                      const meta = STATE_META[d.state]
                      const unapplied = Number(
                        d.current_unapplied_amt ?? d.unapplied_at_decision ?? 0,
                      )
                      const applyAmount = Math.min(unapplied, balance)
                      const isCandidate = d.state === "candidate"
                      return (
                        <tr
                          key={d.credit_id}
                          className="border-b border-line-soft/60 last:border-b-0"
                        >
                          <td className="py-2 pr-2 text-ink-dim">
                            {d.credit_type === "credit_memo"
                              ? "Credit memo"
                              : "Payment"}
                          </td>
                          <td className="py-2 pr-2 text-ink-dim font-mono text-[11px]">
                            {d.ref_num ?? "—"}
                          </td>
                          <td className="py-2 pr-2 text-ink-mute text-[11px]">
                            {d.txn_date ? formatDate(d.txn_date) : "—"}
                          </td>
                          <td className="py-2 pr-2 text-[11px]">
                            {d.reason ? (
                              <span
                                className="text-cyan"
                                title={`auto-match: ${d.reason}`}
                              >
                                {d.reason.replace(/_/g, " ")}
                              </span>
                            ) : (
                              <span className="text-ink-mute">—</span>
                            )}
                          </td>
                          <td className="py-2 pr-2 text-right num text-ink-dim">
                            {formatCurrency(unapplied)}
                          </td>
                          <td className="py-2 pr-2">
                            <span
                              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${meta.cls}`}
                              title={
                                d.state === "applied"
                                  ? `applied via ${d.applied_via ?? "—"}`
                                  : d.state === "stale"
                                    ? `closed: ${d.decided_by ?? "reality changed"}`
                                    : d.decided_by
                                      ? `by ${d.decided_by}`
                                      : undefined
                              }
                            >
                              {d.state === "candidate" && (
                                <Clock className="w-2.5 h-2.5" strokeWidth={2.5} />
                              )}
                              {d.state === "applied" && (
                                <CheckCircle2
                                  className="w-2.5 h-2.5"
                                  strokeWidth={2.5}
                                />
                              )}
                              {(d.state === "rejected" || d.state === "stale") && (
                                <XCircle className="w-2.5 h-2.5" strokeWidth={2.5} />
                              )}
                              {meta.label}
                            </span>
                          </td>
                          <td className="py-2 text-right whitespace-nowrap">
                            {isCandidate && (
                              <span className="inline-flex gap-1.5">
                                <Button
                                  size="sm"
                                  variant="default"
                                  onClick={() => applyCredit(d.credit_id)}
                                  disabled={busy !== null || applyAmount <= 0}
                                  title={
                                    applyAmount <= 0
                                      ? "Nothing to apply — invoice balance is 0"
                                      : `Apply ${formatCurrency(applyAmount)} to this invoice`
                                  }
                                >
                                  {busy === `apply:${d.credit_id}` ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Coins className="w-3.5 h-3.5" strokeWidth={2} />
                                  )}
                                  Apply
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => rejectCredit(d.credit_id)}
                                  disabled={busy !== null}
                                  title="Not applicable to this invoice"
                                >
                                  {busy === `reject:${d.credit_id}` ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    "Reject"
                                  )}
                                </Button>
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Credits that arrived after pre-process ran — no decision row
                yet. The charge worker's claim-time guard sends the invoice
                back through pre-process if these are still undecided. */}
            {newSinceReview.length > 0 && (
              <div className="rounded-md border border-line-soft bg-bg-elev px-3 py-2 text-[12px]">
                <div className="text-[10px] uppercase tracking-[0.08em] text-ink-mute mb-1">
                  New since pre-process
                </div>
                {newSinceReview.map((c) => (
                  <div
                    key={c.qbo_payment_id}
                    className="flex items-baseline justify-between py-0.5"
                  >
                    <span className="text-ink-dim truncate pr-3" title={c.memo ?? undefined}>
                      {c.type === "credit_memo" ? "Credit memo" : "Payment"}{" "}
                      {c.ref_num ?? ""} {c.memo ? `· ${c.memo}` : ""}
                    </span>
                    <span className="num text-sun">
                      {formatCurrency(Number(c.unapplied_amt ?? 0))}
                    </span>
                  </div>
                ))}
                <div className="text-[11px] text-ink-mute mt-1">
                  Will get a decision on the next pre-process run; the charge is
                  guarded until then.
                </div>
              </div>
            )}

            {/* Complete review */}
            {candidates.length > 0 && (
              <div className="pt-2 border-t border-line-soft">
                {completeOpen ? (
                  <div className="space-y-2">
                    <div className="text-[11px] text-ink-mute">
                      Completes review: remaining {candidates.length} open credit
                      {candidates.length === 1 ? "" : "s"} marked rejected; the
                      invoice moves to{" "}
                      <code className="text-ink">ready_to_process</code> when all
                      other gates are clean.
                    </div>
                    <input
                      type="text"
                      value={completeNote}
                      onChange={(e) => setCompleteNote(e.target.value)}
                      placeholder="Reason (optional) — e.g. credit is for WO 4959388"
                      className="w-full bg-bg-elev border border-line rounded-md px-3 py-1.5 text-ink text-sm focus:outline-none focus:border-cyan"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={completeReview}
                        disabled={busy !== null}
                      >
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
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setCompleteOpen(true)}
                    disabled={busy !== null}
                  >
                    Complete review — reject remaining credits
                  </Button>
                )}
              </div>
            )}
          </>
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
