"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  Coins,
  AlertCircle,
  Loader2,
  CheckCircle2,
} from "lucide-react"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { OpenCredit } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"

/**
 * Credit review card for the WO detail page. Mirrors the triage mode
 * "Open Credits" tab: table of applicable credits with per-row Apply
 * button, plus an Override action when the credits aren't actually
 * applicable to this invoice.
 *
 * Shown when the invoice is in needs_review with credit_review in the
 * reason, OR any time applicable open credits exist so the user can
 * pre-emptively apply them.
 */

interface Props {
  qboInvoiceId: string
  balance: number
  credits: OpenCredit[]
  /** Whether the user has already overridden credit review on this invoice. */
  overriddenAt: string | null
}

export function CreditReviewCard({
  qboInvoiceId,
  balance,
  credits,
  overriddenAt,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overrideNote, setOverrideNote] = useState("")
  const router = useRouter()
  const [, startTransition] = useTransition()

  // If there are no applicable credits AND no prior override, no card to show
  if (credits.length === 0 && !overriddenAt) return null

  async function applyCredit(creditId: string) {
    setBusy(creditId); setErr(null)
    try {
      const resp = await fetch(
        `/api/billing/invoices/${qboInvoiceId}/apply-credit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credit_id: creditId }),
        },
      )
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      // Apply + chain pre_process takes ~5-7s
      setTimeout(() => {
        startTransition(() => router.refresh())
        setBusy(null)
      }, 6000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "apply failed")
      setBusy(null)
    }
  }

  async function override() {
    setBusy("override"); setErr(null)
    try {
      const resp = await fetch(
        `/api/billing/invoices/${qboInvoiceId}/override-credit-review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: overrideNote || null }),
        },
      )
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      setOverrideOpen(false)
      setOverrideNote("")
      startTransition(() => router.refresh())
    } catch (e) {
      setErr(e instanceof Error ? e.message : "override failed")
    } finally {
      setBusy(null)
    }
  }

  const totalUnapplied = credits.reduce(
    (a, c) => a + Number(c.unapplied_amt ?? 0),
    0,
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Credit review</CardTitle>
        {overriddenAt ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-grass">
            <CheckCircle2 className="w-3 h-3" strokeWidth={2.5} />
            overridden {new Date(overriddenAt).toLocaleDateString()}
          </span>
        ) : (
          credits.length > 0 && (
            <span className="ml-auto text-[11px] text-sun">
              {credits.length} open · {formatCurrency(totalUnapplied)}
            </span>
          )
        )}
      </CardHeader>
      <CardBody className="text-sm space-y-3">
        {credits.length === 0 ? (
          <div className="text-[12px] text-ink-mute italic">
            No applicable open credits on this customer right now.
          </div>
        ) : (
          <>
            <div className="rounded-md border border-sun/30 bg-sun/[0.05] px-3 py-2 text-[12px] flex items-start gap-2">
              <AlertCircle
                className="w-3.5 h-3.5 text-sun flex-shrink-0 mt-0.5"
                strokeWidth={2}
              />
              <div className="text-ink-dim leading-relaxed">
                {credits.length} open credit{credits.length === 1 ? "" : "s"} on this
                customer,{" "}
                <span className="text-sun font-medium">
                  {formatCurrency(totalUnapplied)}
                </span>{" "}
                unapplied. Apply below or override if credits are for a different WO.
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-ink-mute border-b border-line-soft">
                    <th className="pb-1.5 pr-2 font-medium">Type</th>
                    <th className="pb-1.5 pr-2 font-medium">Ref</th>
                    <th className="pb-1.5 pr-2 font-medium">Date</th>
                    <th className="pb-1.5 pr-2 font-medium">Memo</th>
                    <th className="pb-1.5 pr-2 text-right font-medium num">
                      Unapplied
                    </th>
                    <th className="pb-1.5 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {credits.map((c) => {
                    const applyAmount = Math.min(
                      Number(c.unapplied_amt ?? 0),
                      balance,
                    )
                    const disabled = busy !== null || applyAmount <= 0
                    return (
                      <tr
                        key={c.qbo_payment_id}
                        className="border-b border-line-soft/60 last:border-b-0"
                      >
                        <td className="py-2 pr-2 text-ink-dim">
                          {c.type === "credit_memo" ? "Credit memo" : "Payment"}
                        </td>
                        <td className="py-2 pr-2 text-ink-dim font-mono text-[11px]">
                          {c.ref_num ?? "—"}
                        </td>
                        <td className="py-2 pr-2 text-ink-mute text-[11px]">
                          {c.txn_date ? formatDate(c.txn_date) : "—"}
                        </td>
                        <td
                          className="py-2 pr-2 text-ink-dim max-w-[240px] truncate"
                          title={c.memo ?? undefined}
                        >
                          {c.memo ?? "—"}
                        </td>
                        <td className="py-2 pr-2 text-right text-sun num">
                          {formatCurrency(Number(c.unapplied_amt ?? 0))}
                        </td>
                        <td className="py-2 text-right">
                          <Button
                            size="sm"
                            variant="default"
                            onClick={() => applyCredit(c.qbo_payment_id)}
                            disabled={disabled}
                            title={
                              applyAmount <= 0
                                ? "Nothing to apply — invoice balance is 0"
                                : `Apply ${formatCurrency(applyAmount)} to this invoice`
                            }
                          >
                            {busy === c.qbo_payment_id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Coins className="w-3.5 h-3.5" strokeWidth={2} />
                            )}
                            {busy === c.qbo_payment_id
                              ? "Applying..."
                              : `Apply ${formatCurrency(applyAmount)}`}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Override block */}
            {!overriddenAt && (
              <div className="pt-2 border-t border-line-soft">
                {overrideOpen ? (
                  <div className="space-y-2">
                    <div className="text-[11px] text-ink-mute">
                      Override when credits are for a different WO / not applicable.
                      Flips to <code className="text-ink">ready_to_process</code>{" "}
                      and future pre_process runs skip the credit_review flag.
                    </div>
                    <input
                      type="text"
                      value={overrideNote}
                      onChange={(e) => setOverrideNote(e.target.value)}
                      placeholder="Reason (optional) — e.g. credit is for WO 4959388"
                      className="w-full bg-bg-elev border border-line rounded-md px-3 py-1.5 text-ink text-sm focus:outline-none focus:border-cyan"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={override}
                        disabled={busy !== null}
                      >
                        {busy === "override" ? "Overriding..." : "Confirm override"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setOverrideOpen(false)
                          setOverrideNote("")
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
                    onClick={() => setOverrideOpen(true)}
                    disabled={busy !== null}
                  >
                    Override — credits not applicable to this invoice
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
