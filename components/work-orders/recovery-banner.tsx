"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { AlertTriangle, AlertCircle, RefreshCw, Mail, Check } from "lucide-react"
import type { ProcessAttempt } from "@/lib/queries/dashboard"
import { formatCurrency } from "@/lib/utils/format"

/**
 * Shows on WO detail page when the latest process attempt lands in a state
 * that needs human attention or action. Clickable actions hit /api/billing/process
 * with the right flags.
 *
 *   payment_orphan → RED. "Recover Payment" re-attempts record_payment using the
 *                    persisted charge_id (does NOT charge again). Must confirm.
 *   charge_declined → YELLOW. "Re-process" bypasses the status guard and starts
 *                     a fresh attempt (new idempotency key, new charge call).
 *                     Useful when customer updated their card.
 *   email_failed → YELLOW. "Retry Email" re-triggers the flow; script sees
 *                  email-only path and tries again.
 *   charge_uncertain → BLUE. Informational only — reconciliation will resolve,
 *                      or a manual retry reuses the same idempotency key.
 *   pending / charge_succeeded → BLUE. In flight — no actions.
 *   succeeded → nothing shown (handled elsewhere).
 */

type Action = "recover_orphan" | "reprocess" | "retry_email" | "mark_processed"

export function RecoveryBanner({
  attempt,
  qboInvoiceId,
}: {
  attempt: ProcessAttempt
  qboInvoiceId: string
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busy, setBusy] = useState<Action | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<Action | null>(null)

  async function fire(action: Action) {
    setBusy(action)
    setErr(null)
    try {
      // mark_processed has a different endpoint — it's a DB-only flip,
      // no Windmill script involved. The others all go through the
      // /api/billing/process orchestrator.
      if (action === "mark_processed") {
        const resp = await fetch(
          `/api/billing/invoices/${qboInvoiceId}/mark-processed`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        )
        if (!resp.ok) {
          const txt = await resp.text()
          throw new Error(txt.slice(0, 200))
        }
        setConfirming(null)
        startTransition(() => router.refresh())
        setBusy(null)
        return
      }

      const body: Record<string, unknown> = { qbo_invoice_id: qboInvoiceId }
      if (action === "recover_orphan") body.recover_orphan = true
      if (action === "reprocess" || action === "retry_email") body.force = true

      const resp = await fetch("/api/billing/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const txt = await resp.text()
        throw new Error(txt.slice(0, 200))
      }
      setConfirming(null)
      setTimeout(() => {
        startTransition(() => router.refresh())
        setBusy(null)
      }, 6000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "unknown error")
      setBusy(null)
      setConfirming(null)
    }
  }

  if (attempt.status === "payment_orphan") {
    const amount = Number(attempt.charge_amount ?? 0)
    return (
      <div className="rounded-xl border border-coral/50 bg-coral/[0.08] p-4 space-y-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-coral flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-coral font-medium text-sm">
              Payment orphan — charge went through but QBO payment record failed
            </div>
            <div className="text-ink-dim text-[12px] mt-1 leading-relaxed">
              Card was charged <span className="font-mono text-sun">{formatCurrency(amount)}</span>{" "}
              (charge <span className="font-mono text-ink">{attempt.charge_id}</span>) but the
              QBO Payment record didn&apos;t save.{" "}
              <strong>Verify in QBO and Intuit Payments before clicking Recover.</strong>{" "}
              Recover will retry the record_payment step using the existing charge_id — it will
              NOT charge the card again.
            </div>
            {attempt.error_message && (
              <div className="text-coral/70 text-[11px] mt-2 font-mono break-words">
                {attempt.error_message}
              </div>
            )}
          </div>
        </div>
        {confirming === "recover_orphan" ? (
          <div className="flex items-center gap-2 pl-8">
            <span className="text-ink-dim text-[12px]">
              Have you verified the charge in QBO + Intuit Payments?
            </span>
            <Button
              size="sm"
              variant="primary"
              onClick={() => fire("recover_orphan")}
              disabled={busy !== null}
            >
              {busy === "recover_orphan" ? "Recovering..." : "Yes — Recover Payment"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 pl-8">
            <Button
              size="sm"
              variant="default"
              onClick={() => setConfirming("recover_orphan")}
              disabled={busy !== null}
            >
              <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} />
              Recover Payment
            </Button>
            {err && <span className="text-[11px] text-coral">{err}</span>}
          </div>
        )}
      </div>
    )
  }

  if (attempt.status === "charge_declined") {
    return (
      <div className="rounded-xl border border-sun/40 bg-sun/[0.06] p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-sun flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sun font-medium text-sm">Charge declined</div>
            <div className="text-ink-dim text-[12px] mt-1 leading-relaxed">
              {attempt.error_message || "Intuit returned a definitive failure. No money moved."}{" "}
              Verify the customer&apos;s card on file is current before retrying. Retry creates a
              fresh attempt with a new idempotency key.
            </div>
          </div>
          <Button
            size="sm"
            variant="default"
            onClick={() => fire("reprocess")}
            disabled={busy !== null}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy === "reprocess" ? "animate-spin" : ""}`} strokeWidth={2} />
            {busy === "reprocess" ? "Retrying..." : "Re-process"}
          </Button>
        </div>
        {err && <div className="pl-8 text-[11px] text-coral mt-2">{err}</div>}
      </div>
    )
  }

  if (attempt.status === "email_failed") {
    return (
      <div className="rounded-xl border border-sun/40 bg-sun/[0.06] p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-sun flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sun font-medium text-sm">Email send failed</div>
            <div className="text-ink-dim text-[12px] mt-1 leading-relaxed">
              {attempt.error_message || "Email send failed after retries."}{" "}
              Financial state (if any charge happened) is unaffected.{" "}
              <span className="text-ink-dim">Retry Email</span> re-attempts the send.{" "}
              <span className="text-ink-dim">Mark Processed</span> closes the invoice
              without sending — use when the customer has no valid email on file.
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              size="sm"
              variant="default"
              onClick={() => fire("retry_email")}
              disabled={busy !== null}
            >
              <Mail className={`w-3.5 h-3.5 ${busy === "retry_email" ? "animate-spin" : ""}`} strokeWidth={2} />
              {busy === "retry_email" ? "Sending..." : "Retry Email"}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => fire("mark_processed")}
              disabled={busy !== null}
            >
              <Check className="w-3.5 h-3.5" strokeWidth={2} />
              {busy === "mark_processed" ? "Marking..." : "Mark Processed"}
            </Button>
          </div>
        </div>
        {err && <div className="pl-8 text-[11px] text-coral mt-2">{err}</div>}
      </div>
    )
  }

  if (attempt.status === "charge_uncertain") {
    return (
      <div className="rounded-xl border border-cyan/40 bg-cyan/[0.06] p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-cyan flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-cyan font-medium text-sm">Charge state uncertain</div>
            <div className="text-ink-dim text-[12px] mt-1 leading-relaxed">
              Charge request returned a 5xx or timed out. Money may or may not have moved.
              Reconciliation will resolve this against Intuit&apos;s records, or you can retry
              manually — the same idempotency key is reused, so Intuit will either return the
              original charge (if it landed) or process fresh (if it didn&apos;t). Either way,
              no double-charge.
            </div>
            {attempt.idempotency_key && (
              <div className="text-ink-mute text-[11px] mt-2 font-mono">
                key: {attempt.idempotency_key}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (attempt.status === "charge_succeeded") {
    return (
      <div className="rounded-xl border border-cyan/40 bg-cyan/[0.06] p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-cyan flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-cyan font-medium text-sm">
              Charge succeeded — ledger write pending
            </div>
            <div className="text-ink-dim text-[12px] mt-1 leading-relaxed">
              Card was charged (charge{" "}
              <span className="font-mono text-ink">{attempt.charge_id}</span>). The next process
              run will auto-resume from the QBO Payment step. No action needed.
            </div>
          </div>
        </div>
      </div>
    )
  }

  // pending or succeeded — no banner
  return null
}
