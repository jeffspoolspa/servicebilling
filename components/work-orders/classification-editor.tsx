"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Check,
  Loader2,
  Pencil,
  ChevronDown,
  ChevronRight,
  Lock,
} from "lucide-react"

/**
 * Editable classification panel for an invoice in needs_review or
 * awaiting_pre_processing.
 *
 * Behavior:
 *   - Collapsed by default. Most invoices don't need editing — the panel
 *     only opens when the user clicks the chevron, OR auto-opens when the
 *     memo is flagged low-confidence (because that means action is needed).
 *   - "Save & mark ready" only enabled when the user has actually changed
 *     something OR the memo is flagged low-confidence (the lock affirmation
 *     is itself a meaningful action even without a text change).
 *   - On click: pushes edits to QBO via push_invoice_edits, locks memo,
 *     marks enrichment_ok=true, clears memo_low_confidence reason. The
 *     reactive recheck flips billing_status to ready_to_process if no
 *     other reasons remain.
 *   - QBO Class + Payment Method side-by-side (they're narrow).
 *   - "Save & re-run pre-processing" remains as escape hatch when memo
 *     genuinely needs Claude to regenerate (description changed in ION,
 *     etc.).
 */

const QBO_CLASS_OPTIONS = ["Service", "Delivery", "Maintenance", "Renovation"] as const
const PAYMENT_METHOD_OPTIONS = [
  { value: "on_file", label: "On file (charge card/ACH)" },
  { value: "invoice", label: "Invoice (email only)" },
] as const

interface Props {
  qboInvoiceId: string
  initial: {
    qbo_class: string | null
    payment_method: string | null
    memo: string | null
    statement_memo: string | null
  }
  /** When true (needs_review), user can mark ready without re-running pre-processing. */
  canMarkReady: boolean
  /** Current needs_review_reason; used to detect memo_low_confidence flag and auto-expand. */
  needsReviewReason?: string | null
}

export function ClassificationEditor({
  qboInvoiceId,
  initial,
  canMarkReady,
  needsReviewReason,
}: Props) {
  const memoLowConfidence = (needsReviewReason ?? "").includes("memo_low_confidence")
  // Auto-expand when memo is flagged — that's the case where the user
  // actually needs to look at this. Otherwise stay collapsed by default.
  const [expanded, setExpanded] = useState(memoLowConfidence)

  const [qboClass, setQboClass] = useState(initial.qbo_class ?? "Service")
  const [paymentMethod, setPaymentMethod] = useState(initial.payment_method ?? "invoice")
  const [memo, setMemo] = useState(initial.memo ?? "")
  const [statementMemo, setStatementMemo] = useState(initial.statement_memo ?? initial.memo ?? "")
  const [busy, setBusy] = useState<"ready" | "rerun" | null>(null)
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  const dirty =
    qboClass !== (initial.qbo_class ?? "Service") ||
    paymentMethod !== (initial.payment_method ?? "invoice") ||
    memo !== (initial.memo ?? "") ||
    statementMemo !== (initial.statement_memo ?? initial.memo ?? "")

  // The "mark ready" action is meaningful when:
  //   - The user changed something (dirty), OR
  //   - The memo is flagged low-confidence (clicking affirms it via memo_locked)
  // Otherwise, hitting "mark ready" would be a no-op against an already-clean state.
  const canSaveAndMarkReady = canMarkReady && (dirty || memoLowConfidence)

  async function onSaveMarkReady() {
    setBusy("ready")
    setMsg(null)
    try {
      const resp = await fetch(
        `/api/billing/invoices/${qboInvoiceId}/save-and-mark-ready`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            qbo_class: qboClass,
            payment_method: paymentMethod,
            memo: memo || null,
            statement_memo: statementMemo || null,
          }),
        },
      )
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      const result = (await resp.json()) as { billing_status?: string }
      setMsg({
        kind: "ok",
        text:
          result.billing_status === "ready_to_process"
            ? "ready to process"
            : `saved (${result.billing_status})`,
      })
      setTimeout(() => startTransition(() => router.refresh()), 400)
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "error" })
    } finally {
      setBusy(null)
    }
  }

  async function onSaveRerun() {
    setBusy("rerun")
    setMsg(null)
    try {
      // For re-run we still write the user's edits first (preserves payment_method)
      // then let pre_process regenerate memo/class.
      const editResp = await fetch(`/api/billing/invoices/${qboInvoiceId}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qbo_class: qboClass,
          payment_method: paymentMethod,
          memo: memo || null,
          statement_memo: statementMemo || null,
        }),
      })
      if (!editResp.ok) throw new Error((await editResp.text()).slice(0, 200))

      const resp = await fetch(`/api/billing/pre-process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qbo_invoice_id: qboInvoiceId, force: true }),
      })
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      setMsg({ kind: "ok", text: "pre-processing queued" })
      setTimeout(() => startTransition(() => router.refresh()), 8000)
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "error" })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      {/* Collapsible header. Click anywhere on the header row to toggle. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-5 py-3 hover:bg-white/[0.02] transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-ink-mute" strokeWidth={2} />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-ink-mute" strokeWidth={2} />
        )}
        <CardTitle className="text-[13px]">Edit classification</CardTitle>
        {memoLowConfidence && (
          <span className="ml-2 text-[10px] uppercase tracking-[0.08em] text-sun font-medium">
            memo needs review
          </span>
        )}
        <Pencil className="w-3.5 h-3.5 text-ink-mute ml-auto" strokeWidth={1.8} />
      </button>

      {expanded && (
        <CardBody className="space-y-4 text-sm pt-0">
          {/* Class + Payment Method side by side — both are narrow dropdowns. */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="QBO class">
              <select
                value={qboClass}
                onChange={(e) => setQboClass(e.target.value)}
                className="w-full bg-bg-elev border border-line rounded-md px-3 py-1.5 text-ink text-sm focus:outline-none focus:border-cyan"
              >
                {QBO_CLASS_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Payment method">
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="w-full bg-bg-elev border border-line rounded-md px-3 py-1.5 text-ink text-sm focus:outline-none focus:border-cyan"
              >
                {PAYMENT_METHOD_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Memo (used on invoice)" hint="WO#NNNN: Short description">
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              className="w-full bg-bg-elev border border-line rounded-md px-3 py-1.5 text-ink text-sm focus:outline-none focus:border-cyan"
            />
          </Field>

          <Field label="Statement memo" hint="Usually same as memo">
            <input
              type="text"
              value={statementMemo}
              onChange={(e) => setStatementMemo(e.target.value)}
              className="w-full bg-bg-elev border border-line rounded-md px-3 py-1.5 text-ink text-sm focus:outline-none focus:border-cyan"
            />
          </Field>

          <div className="flex items-center gap-2 pt-1 flex-wrap">
            {canMarkReady && (
              <Button
                size="sm"
                variant="primary"
                onClick={onSaveMarkReady}
                disabled={!canSaveAndMarkReady || busy !== null}
                title={
                  !canSaveAndMarkReady
                    ? "No changes to save and the memo isn't flagged — nothing to do"
                    : "Push edits to QBO, lock memo, and flip to ready_to_process"
                }
              >
                {busy === "ready" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : memoLowConfidence && !dirty ? (
                  <Lock className="w-3.5 h-3.5" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                {memoLowConfidence && !dirty ? "Lock memo & mark ready" : "Save & mark ready"}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={onSaveRerun}
              disabled={busy !== null}
            >
              {busy === "rerun" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Save &amp; re-run pre-processing
            </Button>
            {msg && (
              <span
                className={`text-[11px] ${msg.kind === "ok" ? "text-teal" : "text-coral"} max-w-[260px] truncate`}
                title={msg.text}
              >
                {msg.text}
              </span>
            )}
          </div>
          <p className="text-[11px] text-ink-mute pt-1">
            <span className="text-ink">Save &amp; mark ready</span>: pushes
            edits to QBO (memo + class), locks the memo, flips to
            ready_to_process.{" "}
            <span className="text-ink">Save &amp; re-run</span>: regenerates
            memo/class via Claude; your payment_method override is preserved.
          </p>
        </CardBody>
      )}
    </Card>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <label className="text-[11px] uppercase tracking-[0.08em] text-ink-mute">{label}</label>
        {hint && <span className="text-[10px] text-ink-mute">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
