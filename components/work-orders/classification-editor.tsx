"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Check, Save, Loader2, Pencil } from "lucide-react"

/**
 * Editable classification panel — shown when invoice is in needs_review or
 * awaiting_pre_processing. Lets the user fix qbo_class / payment_method / memo
 * / statement_memo before either re-running pre-processing (script may
 * overwrite memo/class) or marking ready directly (accepts the edits as-is).
 *
 * Save flow:
 *   1. "Save & keep editing" — writes edits, stays in needs_review
 *   2. "Save & mark ready" — writes edits + flips to ready_to_process
 *   3. "Save & re-run pre-processing" — writes edits + triggers pre-processing
 *      (which may overwrite qbo_class and memo, but will pick up the user's
 *      payment_method edit via the classification step)
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
}

export function ClassificationEditor({ qboInvoiceId, initial, canMarkReady }: Props) {
  const [qboClass, setQboClass] = useState(initial.qbo_class ?? "Service")
  const [paymentMethod, setPaymentMethod] = useState(initial.payment_method ?? "invoice")
  const [memo, setMemo] = useState(initial.memo ?? "")
  const [statementMemo, setStatementMemo] = useState(initial.statement_memo ?? initial.memo ?? "")
  const [busy, setBusy] = useState<"save" | "ready" | "rerun" | null>(null)
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
  const [, startTransition] = useTransition()
  const router = useRouter()

  const dirty =
    qboClass !== (initial.qbo_class ?? "Service") ||
    paymentMethod !== (initial.payment_method ?? "invoice") ||
    memo !== (initial.memo ?? "") ||
    statementMemo !== (initial.statement_memo ?? initial.memo ?? "")

  async function save(): Promise<boolean> {
    const resp = await fetch(`/api/billing/invoices/${qboInvoiceId}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        qbo_class: qboClass,
        payment_method: paymentMethod,
        memo: memo || null,
        statement_memo: statementMemo || null,
      }),
    })
    if (!resp.ok) {
      throw new Error((await resp.text()).slice(0, 200))
    }
    return true
  }

  async function onSave() {
    setBusy("save"); setMsg(null)
    try {
      await save()
      setMsg({ kind: "ok", text: "saved" })
      startTransition(() => router.refresh())
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "error" })
    } finally {
      setBusy(null)
    }
  }

  async function onSaveMarkReady() {
    setBusy("ready"); setMsg(null)
    try {
      await save()
      const resp = await fetch(`/api/billing/invoices/${qboInvoiceId}/mark-ready`, { method: "POST" })
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      setMsg({ kind: "ok", text: "marked ready to process" })
      setTimeout(() => startTransition(() => router.refresh()), 400)
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "error" })
    } finally {
      setBusy(null)
    }
  }

  async function onSaveRerun() {
    setBusy("rerun"); setMsg(null)
    try {
      await save()
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
      <CardHeader>
        <CardTitle>Edit classification</CardTitle>
        <Pencil className="w-3.5 h-3.5 text-ink-mute ml-auto" strokeWidth={1.8} />
      </CardHeader>
      <CardBody className="space-y-4 text-sm">
        <Field label="QBO class">
          <select
            value={qboClass}
            onChange={(e) => setQboClass(e.target.value)}
            className="w-full bg-bg-elev border border-line rounded-md px-3 py-1.5 text-ink text-sm focus:outline-none focus:border-cyan"
          >
            {QBO_CLASS_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
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
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </Field>

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
          <Button size="sm" variant="default" onClick={onSave} disabled={!dirty || busy !== null}>
            {busy === "save" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save
          </Button>
          {canMarkReady && (
            <Button size="sm" variant="primary" onClick={onSaveMarkReady} disabled={busy !== null}>
              {busy === "ready" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Save &amp; mark ready
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onSaveRerun} disabled={busy !== null}>
            {busy === "rerun" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Save &amp; re-run pre-processing
          </Button>
          {msg && (
            <span
              className={`text-[11px] ${msg.kind === "ok" ? "text-teal" : "text-coral"} max-w-[220px] truncate`}
              title={msg.text}
            >
              {msg.text}
            </span>
          )}
        </div>
        <p className="text-[11px] text-ink-mute pt-1">
          <span className="text-ink">Save &amp; mark ready</span>: accepts your edits, skips re-running pre-processing.{" "}
          <span className="text-ink">Save &amp; re-run</span>: may regenerate memo/class via Claude; your payment_method override is preserved.
        </p>
      </CardBody>
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
