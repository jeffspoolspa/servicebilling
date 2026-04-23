"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Check,
  ChevronRight,
  ExternalLink,
  SkipForward,
  RotateCw,
  DollarSign,
  Tag,
  User,
  Calendar,
  CreditCard,
  Mail,
  Coins,
  X,
  Keyboard,
  AlertCircle,
  Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Pill } from "@/components/ui/pill"
import { ExpandableText } from "@/components/ui/expandable-text"
import type { TriageRow, LineItem, OpenCredit } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"
import { useFreshResource } from "@/lib/hooks/use-fresh-resource"

// Subset of TriageRow fields that the /api/qbo/refresh/invoice endpoint
// can authoritatively refresh (balance, status, classification, etc.).
// WO fields and open_credits are NOT invoice-owned — they come from the
// snapshot + the customer-credits hook respectively.
type InvoicePatch = Partial<
  Pick<
    TriageRow,
    | "balance"
    | "total_amt"
    | "invoice_subtotal"
    | "email_status"
    | "line_items"
    | "payment_method"
    | "qbo_class"
    | "memo"
    | "statement_memo"
    | "needs_review_reason"
    | "subtotal_ok"
    | "enrichment_ok"
    | "credit_review_overridden_at"
    | "doc_number"
    | "customer_name"
  >
>

function extractInvoicePatch(inv: Record<string, unknown>): InvoicePatch {
  // Fresh invoice payload from /api/qbo/refresh/invoice — maps the
  // refresh_invoice script's return shape into TriageRow field names
  // (note `subtotal` → `invoice_subtotal`).
  const num = (v: unknown) => (v == null ? null : Number(v))
  return {
    balance: num(inv.balance),
    total_amt: num(inv.total_amt),
    invoice_subtotal: num(inv.subtotal),
    email_status: (inv.email_status ?? null) as string | null,
    line_items: (inv.line_items ?? null) as LineItem[] | null,
    payment_method: (inv.payment_method ?? null) as string | null,
    qbo_class: (inv.qbo_class ?? null) as string | null,
    memo: (inv.memo ?? null) as string | null,
    statement_memo: (inv.statement_memo ?? null) as string | null,
    needs_review_reason: (inv.needs_review_reason ?? null) as string | null,
    subtotal_ok: (inv.subtotal_ok ?? null) as boolean | null,
    enrichment_ok: (inv.enrichment_ok ?? null) as boolean | null,
    credit_review_overridden_at:
      (inv.credit_review_overridden_at ?? null) as string | null,
    doc_number: (inv.doc_number ?? null) as string | null,
    customer_name: (inv.customer_name ?? null) as string | null,
  }
}

/**
 * Rapid triage UI for the needs_review queue.
 *
 * Built for the reviewer who wants to burn down 61 invoices without clicking
 * into each detail page. One card per invoice, keyboard-first, advance with
 * `a` (approve) or `s` (skip). Edits to memo/class/method apply on approve.
 *
 * ARCHITECTURE
 *
 *   - Props: server-loaded snapshot of `needs_review` invoices with full WO
 *     context (TriageRow[]). This is stable across the session — the view
 *     doesn't refetch. Stale entries (invoice changed status elsewhere) are
 *     handled gracefully at action time via the mark_invoice_ready RPC's
 *     precondition check.
 *   - State: `cursor` index + per-invoice `edits` map + `actions` log.
 *   - Actions fire RPCs, advance the cursor on success, keep the card in
 *     place on failure with an error message inline.
 *   - Animations: `triage-card-enter` keyed on qbo_invoice_id for the swap,
 *     `triage-approve-flash` on the card before advancing after approve.
 *
 * KEYBOARD
 *   a / Enter  — approve (save + mark ready + advance)
 *   s / →      — skip (advance, leave in needs_review)
 *   r          — save edits + re-run pre-processing (advances when triggered)
 *   d          — open WO detail page (leaves triage)
 *   ←          — previous card
 *   Esc        — exit back to Needs Review list
 *   Tab        — cycle through editable fields (native)
 */

type Action = "approve" | "skip" | "reprocess"

interface Edits {
  qbo_class?: string
  payment_method?: string
  memo?: string
  statement_memo?: string
}

type RowOutcome = "approved" | "skipped" | "reprocessed" | "errored"

const QBO_CLASS_OPTIONS = ["Service", "Delivery", "Maintenance", "Renovation"] as const

export function TriageReviewer({ rows }: { rows: TriageRow[] }) {
  const router = useRouter()
  const [cursor, setCursor] = useState(0)
  const [edits, setEdits] = useState<Record<string, Edits>>({})
  const [outcomes, setOutcomes] = useState<Record<string, RowOutcome>>({})
  const [busy, setBusy] = useState<Action | null>(null)
  const [flash, setFlash] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const memoInputRef = useRef<HTMLInputElement | null>(null)

  // ─── Freshness ──────────────────────────────────────────────────────────
  // Order is frozen at mount (keyboard cursor depends on it). DATA is
  // live: we layer fresh invoice + credit overrides on top of the snapshot
  // so individual fields can update without reshuffling or removing cards.
  //
  // Two maps, two hooks. The hooks fetch for the active card's invoice +
  // customer on cursor change (debounced, TTL-gated, race-guarded — see
  // lib/hooks/use-fresh-resource.ts). Their onUpdate callbacks write into
  // these maps, which persist across cursor moves so scrolling back
  // doesn't refetch within the TTL window.
  const [freshInvoices, setFreshInvoices] = useState<Record<string, InvoicePatch>>({})
  const [freshCredits, setFreshCredits] = useState<Record<string, OpenCredit[]>>({})

  const snapshot = rows[cursor]
  // Resolve the active card from snapshot + live overrides.
  const current: TriageRow | undefined = useMemo(() => {
    if (!snapshot) return undefined
    const invPatch = freshInvoices[snapshot.qbo_invoice_id]
    const custId = snapshot.qbo_customer_id
    const liveCredits = custId ? freshCredits[custId] : undefined
    return {
      ...snapshot,
      ...(invPatch ?? {}),
      open_credits: liveCredits ?? snapshot.open_credits ?? [],
    }
  }, [snapshot, freshInvoices, freshCredits])

  const activeInvoiceId = current?.qbo_invoice_id ?? null
  const activeCustomerId = current?.qbo_customer_id ?? null

  // Active-invoice freshness. When cursor changes to a new invoice, this
  // hook fires /api/qbo/refresh/invoice/{id} (with TTL + debounce). On
  // response, we patch freshInvoices so the card re-renders in place.
  useFreshResource<InvoicePatch>({
    key: activeInvoiceId,
    initial: {},
    ttlMs: 60_000,
    debounceMs: 250,
    fetcher: async (id, signal) => {
      const resp = await fetch(`/api/qbo/refresh/invoice/${id}`, {
        method: "POST",
        signal,
      })
      if (!resp.ok) throw new Error(`invoice refresh ${resp.status}`)
      const body = (await resp.json()) as { invoice?: Record<string, unknown> }
      return body.invoice ? extractInvoicePatch(body.invoice) : {}
    },
    onUpdate: (fresh, id) => {
      setFreshInvoices((prev) => ({ ...prev, [id]: fresh }))
    },
    onError: (e, id) =>
      console.warn(`triage: invoice refresh failed for ${id}:`, e.message),
  })

  // Active-customer credit freshness. When cursor moves to a card whose
  // customer we haven't refreshed within TTL, fire the customer credits
  // refresh. Keyed by qbo_customer_id so multiple cards for the same
  // customer share one refresh.
  //
  // IMPORTANT: the endpoint returns BOTH fresh credits AND an
  // invoice_patches map (reconciled billing_status / needs_review_reason
  // for every non-terminal invoice of this customer — the backend's
  // recheck can clear credit_review on multiple invoices at once). We
  // store credits in freshCredits AND fan out the invoice patches to
  // freshInvoices so other cards for the same customer also update in
  // place.
  interface CreditRefreshPayload {
    credits: OpenCredit[]
    invoicePatches: Record<string, Record<string, unknown>>
  }
  useFreshResource<CreditRefreshPayload>({
    key: activeCustomerId,
    initial: { credits: [], invoicePatches: {} },
    ttlMs: 60_000,
    debounceMs: 250,
    fetcher: async (id, signal) => {
      const resp = await fetch(`/api/qbo/refresh/customer/${id}/credits`, {
        method: "POST",
        signal,
      })
      if (!resp.ok) throw new Error(`credits refresh ${resp.status}`)
      const body = (await resp.json()) as {
        credits?: OpenCredit[]
        invoice_patches?: Record<string, Record<string, unknown>>
      }
      return {
        credits: body.credits ?? [],
        invoicePatches: body.invoice_patches ?? {},
      }
    },
    onUpdate: (fresh, id) => {
      setFreshCredits((prev) => ({ ...prev, [id]: fresh.credits }))
      if (fresh.invoicePatches && Object.keys(fresh.invoicePatches).length > 0) {
        // Fan out recheck results to freshInvoices so every visible card
        // for this customer reflects the reconciled billing_status +
        // needs_review_reason.
        setFreshInvoices((prev) => {
          const next = { ...prev }
          for (const [invId, invRow] of Object.entries(fresh.invoicePatches)) {
            next[invId] = {
              ...(next[invId] ?? {}),
              ...extractInvoicePatch(invRow),
            }
          }
          return next
        })
      }
    },
    onError: (e, id) =>
      console.warn(`triage: credit refresh failed for ${id}:`, e.message),
  })

  // Called by OpenCreditsPanel on authoritative apply success. Patches
  // the invoice (balance + status + review_reason from the apply response)
  // AND decrements the specific credit locally so the card reflects the
  // new state without waiting for the hook's next TTL-gated refresh.
  const onAppliedCredit = useCallback(
    (args: {
      creditQboPaymentId: string
      amountApplied: number
      invoicePatch: InvoicePatch
    }) => {
      if (!snapshot) return
      setFreshInvoices((prev) => ({
        ...prev,
        [snapshot.qbo_invoice_id]: {
          ...(prev[snapshot.qbo_invoice_id] ?? {}),
          ...args.invoicePatch,
        },
      }))
      const custId = snapshot.qbo_customer_id
      if (!custId) return
      setFreshCredits((prev) => {
        const existing = prev[custId] ?? snapshot.open_credits ?? []
        const updated = existing
          .map((c) =>
            c.qbo_payment_id === args.creditQboPaymentId
              ? {
                  ...c,
                  unapplied_amt: Math.max(
                    0,
                    Number(c.unapplied_amt ?? 0) - args.amountApplied,
                  ),
                }
              : c,
          )
          .filter((c) => Number(c.unapplied_amt ?? 0) > 0)
        return { ...prev, [custId]: updated }
      })
    },
    [snapshot],
  )

  // Called by OpenCreditsPanel on override success. Patches the invoice
  // with credit_review_overridden_at so downstream panels update.
  const onOverrodeCreditReview = useCallback(() => {
    if (!snapshot) return
    setFreshInvoices((prev) => ({
      ...prev,
      [snapshot.qbo_invoice_id]: {
        ...(prev[snapshot.qbo_invoice_id] ?? {}),
        credit_review_overridden_at: new Date().toISOString(),
      },
    }))
  }, [snapshot])

  // Reset card-level state when we move to a new invoice
  useEffect(() => {
    setErr(null)
    setBusy(null)
    setFlash(false)
  }, [cursor])

  const counts = useMemo(() => {
    const c = { approved: 0, skipped: 0, reprocessed: 0, errored: 0 }
    Object.values(outcomes).forEach((o) => {
      c[o] = (c[o] ?? 0) + 1
    })
    return c
  }, [outcomes])

  const getEdit = useCallback(
    (field: keyof Edits) => {
      if (!current) return undefined
      const cur = edits[current.qbo_invoice_id]
      if (cur && cur[field] !== undefined) return cur[field]
      return undefined
    },
    [edits, current],
  )

  const setEdit = useCallback(
    (field: keyof Edits, value: string) => {
      if (!current) return
      setEdits((prev) => ({
        ...prev,
        [current.qbo_invoice_id]: {
          ...(prev[current.qbo_invoice_id] ?? {}),
          [field]: value,
        },
      }))
    },
    [current],
  )

  const effective = (field: keyof Edits): string | null => {
    if (!current) return null
    const ed = getEdit(field)
    if (ed !== undefined) return ed ?? null
    switch (field) {
      case "qbo_class":
        return current.qbo_class
      case "payment_method":
        return current.payment_method
      case "memo":
        return current.memo
      case "statement_memo":
        return current.statement_memo ?? current.memo
    }
  }

  const isDirty = current ? Boolean(edits[current.qbo_invoice_id]) : false

  const advance = useCallback(() => {
    setCursor((c) => Math.min(rows.length, c + 1))
  }, [rows.length])

  const retreat = useCallback(() => {
    setCursor((c) => Math.max(0, c - 1))
  }, [])

  const saveEdits = useCallback(async (): Promise<boolean> => {
    if (!current || !isDirty) return true
    const e = edits[current.qbo_invoice_id]
    const resp = await fetch(`/api/billing/invoices/${current.qbo_invoice_id}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        qbo_class: e.qbo_class ?? null,
        payment_method: e.payment_method ?? null,
        memo: e.memo ?? null,
        statement_memo: e.statement_memo ?? e.memo ?? null,
      }),
    })
    if (!resp.ok) {
      throw new Error((await resp.text()).slice(0, 200))
    }
    return true
  }, [current, isDirty, edits])

  const approve = useCallback(async () => {
    if (!current || busy) return
    setBusy("approve"); setErr(null)
    try {
      await saveEdits()
      const resp = await fetch(`/api/billing/invoices/${current.qbo_invoice_id}/mark-ready`, {
        method: "POST",
      })
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))

      // Flash the current card, then advance. 180ms keeps the rhythm fast.
      // Do NOT call router.refresh() here — it would refetch the server rows
      // prop underneath our cursor and skip the next card. The list is
      // refreshed only on exit / finish.
      setOutcomes((prev) => ({ ...prev, [current.qbo_invoice_id]: "approved" }))
      setFlash(true)
      setTimeout(() => {
        setFlash(false)
        advance()
      }, 180)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "approve failed")
      setBusy(null)
    }
  }, [current, busy, saveEdits, advance])

  const skip = useCallback(() => {
    if (!current || busy) return
    setOutcomes((prev) => ({ ...prev, [current.qbo_invoice_id]: "skipped" }))
    advance()
  }, [current, busy, advance])

  const reprocess = useCallback(async () => {
    if (!current || busy) return
    setBusy("reprocess"); setErr(null)
    try {
      await saveEdits()
      const resp = await fetch(`/api/billing/pre-process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qbo_invoice_id: current.qbo_invoice_id, force: true }),
      })
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      setOutcomes((prev) => ({ ...prev, [current.qbo_invoice_id]: "reprocessed" }))
      advance()
      // Do NOT router.refresh() — same reason as approve(). Refresh on exit.
    } catch (e) {
      setErr(e instanceof Error ? e.message : "reprocess failed")
      setBusy(null)
    }
  }, [current, busy, saveEdits, advance])

  const openDetail = useCallback(() => {
    if (!current) return
    router.push(`/work-orders/${current.wo_number}` as never)
  }, [current, router])

  const exit = useCallback(() => {
    router.push("/service-billing/needs-attention" as never)
  }, [router])

  // Keyboard shortcuts (only when focus is not in an input/select).
  // Ignores repeated keydown events from held keys — otherwise holding `a`
  // would auto-approve every card as soon as the previous one cleared `busy`.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.repeat) return

      const target = e.target as HTMLElement
      const inField =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT"

      if (e.key === "Escape") {
        e.preventDefault()
        if (inField) {
          ;(target as HTMLInputElement).blur()
        } else {
          exit()
        }
        return
      }

      if (inField) return

      if (e.key === "a" || e.key === "Enter") {
        e.preventDefault()
        approve()
      } else if (e.key === "s" || e.key === "ArrowRight") {
        e.preventDefault()
        skip()
      } else if (e.key === "r") {
        e.preventDefault()
        reprocess()
      } else if (e.key === "d") {
        e.preventDefault()
        openDetail()
      } else if (e.key === "ArrowLeft") {
        e.preventDefault()
        retreat()
      } else if (e.key === "e") {
        e.preventDefault()
        memoInputRef.current?.focus()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [approve, skip, reprocess, openDetail, retreat, exit])

  // ─── Empty / done states ──────────────────────────────────────────────────
  if (rows.length === 0) {
    return (
      <div className="px-7 py-16 flex flex-col items-center text-center gap-3">
        <div className="w-12 h-12 rounded-full bg-grass/15 border border-grass/30 grid place-items-center">
          <Check className="w-5 h-5 text-grass" strokeWidth={2.5} />
        </div>
        <div className="text-ink font-medium">Nothing in needs review.</div>
        <div className="text-ink-mute text-[12px]">Clean queue.</div>
      </div>
    )
  }

  if (cursor >= rows.length) {
    return (
      <div className="px-7 py-16 flex flex-col items-center text-center gap-3">
        <div className="w-12 h-12 rounded-full bg-grass/15 border border-grass/30 grid place-items-center">
          <Check className="w-5 h-5 text-grass" strokeWidth={2.5} />
        </div>
        <div className="text-ink font-medium">Reviewed all {rows.length}.</div>
        <div className="text-ink-mute text-[12px]">
          {counts.approved} approved · {counts.skipped} skipped
          {counts.reprocessed > 0 && ` · ${counts.reprocessed} reprocessed`}
          {counts.errored > 0 && ` · ${counts.errored} errored`}
        </div>
        <div className="flex gap-2 mt-3">
          <Button size="sm" variant="default" onClick={() => router.refresh()}>
            Refresh
          </Button>
          <Button size="sm" variant="ghost" onClick={exit}>
            Back to Needs Review
          </Button>
        </div>
      </div>
    )
  }

  // At this point `cursor < rows.length` is guaranteed by the early
  // returns above, so `current` is defined.
  if (!current) return null
  const remaining = rows.length - cursor
  const progressPct = rows.length > 0 ? (cursor / rows.length) * 100 : 0

  return (
    <div className="px-7 py-6 max-w-3xl mx-auto">
      {/* Header: progress + counts + exit */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex-1">
          <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute">
            Triaging needs_review
          </div>
          <div className="text-ink mt-0.5">
            <span className="font-medium">
              {cursor + 1} of {rows.length}
            </span>
            <span className="text-ink-mute text-[12px] ml-2">
              {remaining - 1} remaining
              {counts.approved > 0 && ` · ${counts.approved} approved`}
              {counts.skipped > 0 && ` · ${counts.skipped} skipped`}
            </span>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={exit} title="Exit (Esc)">
          <X className="w-3.5 h-3.5" strokeWidth={2} />
          Exit
        </Button>
      </div>

      {/* Progress bar — thin, ease-in-out for on-screen motion */}
      <div className="h-1 bg-line-soft rounded-full overflow-hidden mb-4">
        <div
          className="h-full bg-gradient-to-r from-cyan to-teal"
          style={{
            width: `${progressPct}%`,
            transition: "width 200ms cubic-bezier(0.645, 0.045, 0.355, 1)",
          }}
        />
      </div>

      {/* Card — keyed on invoice id so React re-mounts per card and plays
          the enter animation. `row` is the live-resolved view (snapshot +
          fresh overrides), so the card fields update in place when a
          refresh lands without disturbing cursor position. */}
      <Card
        key={current.qbo_invoice_id}
        row={current}
        flash={flash}
        busy={busy}
        err={err}
        effective={effective}
        setEdit={setEdit}
        memoInputRef={memoInputRef}
        onAppliedCredit={onAppliedCredit}
        onOverrodeCreditReview={onOverrodeCreditReview}
      />

      {/* Action bar */}
      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          variant="ghost"
          onClick={retreat}
          disabled={cursor === 0 || busy !== null}
          title="Previous (←)"
        >
          <ChevronRight className="w-3.5 h-3.5 rotate-180" strokeWidth={2} />
          Previous
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={openDetail}
          disabled={busy !== null}
          title="Open work order detail (d)"
        >
          <ExternalLink className="w-3.5 h-3.5" strokeWidth={2} />
          Open detail
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={reprocess}
          disabled={busy !== null}
          title="Save edits and re-run pre-processing (r)"
        >
          <RotateCw
            className={`w-3.5 h-3.5 ${busy === "reprocess" ? "animate-spin" : ""}`}
            strokeWidth={2}
          />
          Re-run
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="default"
          onClick={skip}
          disabled={busy !== null}
          title="Leave in needs_review, advance (s or →)"
        >
          <SkipForward className="w-3.5 h-3.5" strokeWidth={2} />
          Skip
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={approve}
          disabled={busy !== null}
          title="Save + mark ready to process (a or Enter)"
        >
          <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
          {busy === "approve" ? "Approving..." : isDirty ? "Save & approve" : "Approve"}
        </Button>
      </div>

      {/* Keyboard hint strip — presence reminds the user; not intrusive */}
      <div className="mt-4 flex items-center gap-3 text-[10px] text-ink-mute">
        <Keyboard className="w-3 h-3" strokeWidth={1.8} />
        <Kbd k="a" /> approve
        <Kbd k="s" /> skip
        <Kbd k="r" /> re-run
        <Kbd k="d" /> open
        <Kbd k="e" /> edit memo
        <Kbd k="←→" /> nav
        <Kbd k="Esc" /> exit
      </div>
    </div>
  )
}

// ─── Card ────────────────────────────────────────────────────────────────
interface AppliedCreditPatchArgs {
  creditQboPaymentId: string
  amountApplied: number
  invoicePatch: Partial<TriageRow>
}

function Card({
  row,
  flash,
  busy,
  err,
  effective,
  setEdit,
  memoInputRef,
  onAppliedCredit,
  onOverrodeCreditReview,
}: {
  row: TriageRow
  flash: boolean
  busy: Action | null
  err: string | null
  effective: (field: keyof Edits) => string | null
  setEdit: (field: keyof Edits, value: string) => void
  memoInputRef: React.MutableRefObject<HTMLInputElement | null>
  onAppliedCredit: (args: AppliedCreditPatchArgs) => void
  onOverrodeCreditReview: () => void
}) {
  return (
    <div
      className={`triage-card-enter rounded-xl border border-line bg-[#0E1C2A] p-5 space-y-4 ${
        flash ? "triage-approve-flash" : ""
      }`}
    >
      {/* Identity row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-ink font-medium text-[15px] leading-tight flex items-center gap-2">
            <span>{row.customer_name ?? "—"}</span>
            {row.email_status === "EmailSent" ? (
              <span
                className="text-[10px] uppercase tracking-[0.08em] text-teal bg-teal/10 border border-teal/30 rounded-full px-1.5 py-0.5 font-sans font-normal"
                title="Invoice email already sent to customer"
              >
                Sent
              </span>
            ) : (
              <span
                className="text-[10px] uppercase tracking-[0.08em] text-ink-mute bg-bg-elev border border-line rounded-full px-1.5 py-0.5 font-sans font-normal"
                title="Invoice not yet sent — process action will send"
              >
                Not sent
              </span>
            )}
          </div>
          <div className="text-[11px] text-ink-mute mt-1 font-mono flex items-center gap-2 flex-wrap">
            <span>Inv {row.doc_number ?? row.qbo_invoice_id}</span>
            <span>·</span>
            <span>WO {row.wo_number}</span>
            {row.office_name && (
              <>
                <span>·</span>
                <span>{row.office_name}</span>
              </>
            )}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[10px] uppercase tracking-[0.08em] text-ink-mute">
            Invoice balance
          </div>
          {(() => {
            const bal = Number(row.balance ?? 0)
            const paid = bal === 0
            return (
              <div
                className={`num font-medium text-[15px] leading-tight mt-0.5 ${
                  paid ? "text-grass" : "text-sun"
                }`}
              >
                {paid ? "Paid" : formatCurrency(bal)}
              </div>
            )
          })()}
        </div>
      </div>

      {/* Review reason */}
      {row.needs_review_reason && (
        <ReviewReason reason={row.needs_review_reason} />
      )}

      {/* Context + Line items tabs. Auto-lands on line_items when the review
          reason is a subtotal mismatch — that's the one case where the
          invoice breakdown is what matters most. */}
      <ContextAndLineItems
        row={row}
        onAppliedCredit={onAppliedCredit}
        onOverrodeCreditReview={onOverrodeCreditReview}
      />


      {/* Editable classification */}
      <div className="rounded-lg border border-line-soft bg-bg-elev/60 p-3 space-y-3">
        <div className="text-[10px] uppercase tracking-[0.1em] text-ink-mute">
          Classification — edit if needed, then approve
        </div>
        <Field label="Memo">
          <input
            ref={memoInputRef}
            type="text"
            value={effective("memo") ?? ""}
            onChange={(e) => setEdit("memo", e.target.value)}
            className="w-full bg-bg-elev border border-line rounded-md px-3 py-1.5 text-ink text-sm focus:outline-none focus:border-cyan"
            placeholder="WO#NNNN: Short description"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="QBO class">
            <select
              value={effective("qbo_class") ?? "Service"}
              onChange={(e) => setEdit("qbo_class", e.target.value)}
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
              value={effective("payment_method") ?? "invoice"}
              onChange={(e) => setEdit("payment_method", e.target.value)}
              className="w-full bg-bg-elev border border-line rounded-md px-3 py-1.5 text-ink text-sm focus:outline-none focus:border-cyan"
            >
              <option value="on_file">On file (charge)</option>
              <option value="invoice">Invoice (email only)</option>
            </select>
          </Field>
        </div>
      </div>

      {err && (
        <div className="text-[12px] text-coral bg-coral/[0.06] border border-coral/30 rounded-lg px-3 py-2">
          {err}
        </div>
      )}
      {busy === "approve" && (
        <div className="text-[11px] text-cyan">Approving + marking ready…</div>
      )}
    </div>
  )
}

// ─── Context + Line items + Open credits (tabbed) ─────────────────────────
function ContextAndLineItems({
  row,
  onAppliedCredit,
  onOverrodeCreditReview,
}: {
  row: TriageRow
  onAppliedCredit: (args: AppliedCreditPatchArgs) => void
  onOverrodeCreditReview: () => void
}) {
  const hasLineItems = Array.isArray(row.line_items) && row.line_items.length > 0
  const openCredits = row.open_credits ?? []
  const hasCredits = openCredits.length > 0
  const isSubtotalMismatch = Boolean(
    row.needs_review_reason?.toLowerCase().includes("subtotal_mismatch"),
  )
  const isCreditReview = Boolean(
    row.needs_review_reason?.toLowerCase().includes("credit_review"),
  )
  // Auto-select the tab that most directly addresses the review reason.
  const [tab, setTab] = useState<"context" | "items" | "credits">(
    isCreditReview && hasCredits
      ? "credits"
      : isSubtotalMismatch && hasLineItems
        ? "items"
        : "context",
  )

  // Three stacked bands inside the same rounded card, each with a fixed
  // vertical rhythm. No wrapping, no janky heights. The meta strip is
  // separate from the tab strip so the tab bar stays identifiable as tabs.
  return (
    <div className="rounded-lg border border-line-soft bg-bg-elev/40 overflow-hidden">
      {/* Meta strip — WO-level facts that apply to both tabs. Single row,
          won't wrap because all items are short and the container has
          overflow-x-auto as an escape hatch. Payment method icon (CreditCard
          vs Mail) doubles as a quick method indicator. */}
      <div className="flex items-center gap-4 px-3 py-2 border-b border-line-soft text-[11px] whitespace-nowrap overflow-x-auto">
        <MetaItem icon={Tag} label={row.wo_type ?? "—"} />
        <MetaItem
          icon={User}
          label={row.assigned_to?.split(",")[1]?.trim() ?? row.assigned_to ?? "—"}
        />
        <MetaItem
          icon={Calendar}
          label={row.completed ? formatDate(row.completed) : "—"}
        />
        <MetaItem
          icon={DollarSign}
          label={`WO ${formatCurrency(Number(row.sub_total ?? 0))}`}
        />
        <MetaItem
          icon={row.payment_method === "on_file" ? CreditCard : Mail}
          label={row.payment_method === "on_file" ? "Card on file" : "Email only"}
          accent={row.payment_method === "on_file"}
        />
      </div>

      {/* Tab strip — tabs only, full width. Reads as a tab bar. */}
      <div className="flex items-center gap-1 border-b border-line-soft px-2 py-1">
        <TabButton active={tab === "context"} onClick={() => setTab("context")}>
          Context
        </TabButton>
        <TabButton
          active={tab === "items"}
          onClick={() => setTab("items")}
          disabled={!hasLineItems}
          badge={hasLineItems ? String(row.line_items!.length) : undefined}
          emphasized={isSubtotalMismatch}
        >
          Line items
        </TabButton>
        <TabButton
          active={tab === "credits"}
          onClick={() => setTab("credits")}
          disabled={!hasCredits}
          badge={hasCredits ? String(openCredits.length) : undefined}
          emphasized={isCreditReview}
        >
          Open credits
        </TabButton>
      </div>

      {/* Body — consistent min-height so tab swap doesn't jiggle the card. */}
      <div className="p-3 min-h-[180px]">
        {tab === "context" && <ContextPanel row={row} />}
        {tab === "items" && <LineItemsPanel row={row} />}
        {tab === "credits" && (
          <OpenCreditsPanel
            row={row}
            onAppliedCredit={onAppliedCredit}
            onOverrodeCreditReview={onOverrodeCreditReview}
          />
        )}
      </div>
    </div>
  )
}

// Context panel with line-clamped "Show more" per field so initial card
// height stays consistent across invoices regardless of description length.
function ContextPanel({ row }: { row: TriageRow }) {
  const empty =
    !row.work_description && !row.corrective_action && !row.technician_instructions
  if (empty) {
    return (
      <div className="text-[12px] text-ink-mute italic">
        No work description on this WO.
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {row.work_description && (
        <ContextBlock label="Work description" text={row.work_description} />
      )}
      {row.corrective_action && (
        <ContextBlock label="Corrective action" text={row.corrective_action} />
      )}
      {row.technician_instructions && (
        <ContextBlock label="Tech instructions" text={row.technician_instructions} />
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  disabled,
  badge,
  emphasized,
  children,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  badge?: string
  emphasized?: boolean
  children: React.ReactNode
}) {
  const base =
    "relative px-3 py-1.5 text-[11px] uppercase tracking-[0.08em] rounded-md transition-colors duration-150"
  const state = disabled
    ? "text-ink-mute/40 cursor-not-allowed"
    : active
      ? "text-ink bg-bg-elev border border-line"
      : "text-ink-mute hover:text-ink"
  return (
    <button className={`${base} ${state}`} onClick={disabled ? undefined : onClick}>
      {children}
      {badge && (
        <span className="ml-1.5 text-[10px] tabular-nums text-ink-mute">
          {badge}
        </span>
      )}
      {emphasized && !active && !disabled && (
        <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-coral" />
      )}
    </button>
  )
}

function LineItemsPanel({ row }: { row: TriageRow }) {
  const woSub = Number(row.sub_total ?? 0)
  const qboSub = Number(row.invoice_subtotal ?? 0)
  const delta = qboSub - woSub
  const mismatch = Math.abs(delta) >= 0.02

  const items: LineItem[] = row.line_items ?? []
  const nonSubtotal = items.filter((li) => li.line_type !== "subtotal")

  return (
    <div className="space-y-3">
      {/* Subtotal comparison banner — coral when mismatched, quiet otherwise */}
      <div
        className={`rounded-md border px-3 py-2 grid grid-cols-3 gap-2 text-[12px] ${
          mismatch
            ? "border-coral/30 bg-coral/[0.05]"
            : "border-line-soft bg-bg-elev/50"
        }`}
      >
        <Stat label="WO subtotal" value={formatCurrency(woSub)} tone="ink-dim" />
        <Stat label="QBO subtotal" value={formatCurrency(qboSub)} tone="ink-dim" />
        <Stat
          label="Difference"
          value={`${delta >= 0 ? "+" : ""}${formatCurrency(delta)}`}
          tone={mismatch ? "coral" : "grass"}
          mono
        />
      </div>

      {/* Line items table */}
      {nonSubtotal.length === 0 ? (
        <div className="text-[12px] text-ink-mute italic">
          No line items on this invoice.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-ink-mute border-b border-line-soft">
                <th className="pb-1.5 pr-2 font-medium">Item</th>
                <th className="pb-1.5 pr-2 font-medium">Description</th>
                <th className="pb-1.5 pr-2 text-right font-medium num">Qty</th>
                <th className="pb-1.5 pr-2 text-right font-medium num">Rate</th>
                <th className="pb-1.5 text-right font-medium num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {nonSubtotal.map((li, i) => (
                <tr key={i} className="border-b border-line-soft/60 last:border-b-0">
                  <td className="py-1.5 pr-2 text-ink-dim">
                    {li.item_name ?? "—"}
                  </td>
                  <td className="py-1.5 pr-2 text-ink-dim max-w-[280px] truncate" title={li.description ?? undefined}>
                    {li.description ?? "—"}
                  </td>
                  <td className="py-1.5 pr-2 text-right text-ink-dim num">
                    {li.qty ?? "—"}
                  </td>
                  <td className="py-1.5 pr-2 text-right text-ink-dim num">
                    {li.unit_price != null ? formatCurrency(li.unit_price) : "—"}
                  </td>
                  <td className="py-1.5 text-right text-ink num">
                    {li.amount != null ? formatCurrency(li.amount) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
  mono,
}: {
  label: string
  value: string
  tone: "ink-dim" | "coral" | "grass"
  mono?: boolean
}) {
  const toneClass =
    tone === "coral" ? "text-coral" : tone === "grass" ? "text-grass" : "text-ink-dim"
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-ink-mute">
        {label}
      </div>
      <div className={`${toneClass} ${mono ? "font-mono" : ""} num mt-0.5`}>
        {value}
      </div>
    </div>
  )
}

// ─── Open Credits panel ───────────────────────────────────────────────────
function OpenCreditsPanel({
  row,
  onAppliedCredit,
  onOverrodeCreditReview,
}: {
  row: TriageRow
  onAppliedCredit: (args: AppliedCreditPatchArgs) => void
  onOverrodeCreditReview: () => void
}) {
  const credits = row.open_credits ?? []
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [overrideNote, setOverrideNote] = useState("")
  const [overrideDone, setOverrideDone] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Authoritative apply outcome — populated only after QBO confirms. Drives
  // the green "applied X to this invoice, new balance Y" banner.
  const [applied, setApplied] = useState<{
    creditId: string
    amount: number | null
    newBalance: number | null
    newStatus: string | null
  } | null>(null)

  // Synchronous apply — the API now waits for QBO's acknowledgement before
  // returning. We parse the authoritative response and surface it clearly
  // instead of flashing success on any 2xx and hoping.
  async function applyCredit(creditId: string) {
    setBusy(creditId); setErr(null); setApplied(null)
    try {
      const resp = await fetch(
        `/api/billing/invoices/${row.qbo_invoice_id}/apply-credit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credit_id: creditId }),
        },
      )
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        // 422 = QBO rejected (locked period, etc); 502 = script failure.
        // Surface the actual reason so user sees WHY, doesn't advance.
        throw new Error(
          body?.error
            ? `${body.error}${body.detail?.error ? ` — ${body.detail.error}` : ""}`
            : `Apply failed (${resp.status})`,
        )
      }
      const amount: number | null = body.applied_amount ?? null
      const newBalance: number | null = body.invoice?.balance ?? null
      const newStatus: string | null = body.invoice?.billing_status ?? null
      setApplied({ creditId, amount, newBalance, newStatus })

      // Patch the live invoice + credit maps in the parent so the card
      // re-renders with fresh numbers (balance, billing_status) and the
      // applied credit is decremented (or removed if fully exhausted).
      // User doesn't need to wait for a full refresh round-trip.
      onAppliedCredit({
        creditQboPaymentId: creditId,
        amountApplied: Number(amount ?? 0),
        invoicePatch: {
          balance: newBalance,
          billing_status: body.invoice?.billing_status ?? undefined,
          needs_review_reason: body.invoice?.needs_review_reason ?? undefined,
        } as Partial<TriageRow>,
      })
      // DO NOT router.refresh() — that would refetch the snapshot underneath
      // the cursor and make "previous" land on a different invoice. Apply
      // outcomes are shown inline; user advances explicitly.
    } catch (e) {
      setErr(e instanceof Error ? e.message : "apply failed")
    } finally {
      setBusy(null)
    }
  }

  async function override() {
    setBusy("override"); setErr(null)
    try {
      const resp = await fetch(
        `/api/billing/invoices/${row.qbo_invoice_id}/override-credit-review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: overrideNote || null }),
        },
      )
      if (!resp.ok) throw new Error((await resp.text()).slice(0, 200))
      setOverrideOpen(false)
      setOverrideNote("")
      setOverrideDone(true)
      onOverrodeCreditReview()
      // DO NOT router.refresh() — see applyCredit for why. User can hit
      // Approve (a) to move it to ready_to_process and advance, or Skip.
    } catch (e) {
      setErr(e instanceof Error ? e.message : "override failed")
    } finally {
      setBusy(null)
    }
  }

  if (credits.length === 0) {
    return (
      <div className="text-[12px] text-ink-mute italic">
        No applicable open credits on this customer.
      </div>
    )
  }

  const totalUnapplied = credits.reduce(
    (a, c) => a + Number(c.unapplied_amt ?? 0),
    0,
  )

  return (
    <div className="space-y-3">
      {/* Header summary */}
      <div className="rounded-md border border-sun/30 bg-sun/[0.05] px-3 py-2 text-[12px] flex items-center gap-2">
        <AlertCircle className="w-3.5 h-3.5 text-sun" strokeWidth={2} />
        <span className="text-ink-dim">
          {credits.length} open credit{credits.length === 1 ? "" : "s"} on this customer,{" "}
          <span className="text-sun font-medium">{formatCurrency(totalUnapplied)}</span>{" "}
          unapplied. Invoice balance:{" "}
          <span className="text-ink">{formatCurrency(Number(row.balance ?? 0))}</span>
        </span>
      </div>

      {/* Authoritative apply outcome — only renders after QBO confirms. */}
      {applied && (
        <div className="rounded-md border border-grass/40 bg-grass/[0.06] px-3 py-2 text-[12px] flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-grass" strokeWidth={2.5} />
          <span className="text-ink-dim">
            Applied{" "}
            <span className="text-grass font-medium">
              {applied.amount != null ? formatCurrency(applied.amount) : "credit"}
            </span>{" "}
            to this invoice.
            {applied.newBalance != null && (
              <>
                {" "}New balance:{" "}
                <span className="text-ink">{formatCurrency(applied.newBalance)}</span>
                {applied.newBalance === 0 && (
                  <span className="text-grass"> — fully covered</span>
                )}
              </>
            )}
            {applied.newStatus && applied.newStatus !== "needs_review" && (
              <>
                {" "}State:{" "}
                <span className="text-ink">{applied.newStatus}</span>
              </>
            )}
            <span className="text-ink-mute"> · hit Approve to move forward or Skip.</span>
          </span>
        </div>
      )}

      {/* Overridden confirmation */}
      {overrideDone && !applied && (
        <div className="rounded-md border border-cyan/40 bg-cyan/[0.06] px-3 py-2 text-[12px] flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-cyan" strokeWidth={2.5} />
          <span className="text-ink-dim">
            Credit review overridden. Hit <Kbd k="a" /> to approve + advance.
          </span>
        </div>
      )}

      {/* Credits table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-ink-mute border-b border-line-soft">
              <th className="pb-1.5 pr-2 font-medium">Type</th>
              <th className="pb-1.5 pr-2 font-medium">Ref</th>
              <th className="pb-1.5 pr-2 font-medium">Date</th>
              <th className="pb-1.5 pr-2 font-medium">Memo</th>
              <th className="pb-1.5 pr-2 text-right font-medium num">Unapplied</th>
              <th className="pb-1.5 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {credits.map((c) => {
              const applyAmount = Math.min(
                Number(c.unapplied_amt ?? 0),
                Number(row.balance ?? 0),
              )
              // Once a credit was applied this session, prevent re-clicking.
              // The DB row won't show unapplied_amt=0 until the user refreshes
              // or we poll, but WE KNOW it was applied because applied state
              // was set authoritatively. Belt-and-suspenders against
              // double-apply.
              const alreadyApplied = applied?.creditId === c.qbo_payment_id
              const disabled = busy !== null || applyAmount <= 0 || alreadyApplied
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
                      ) : alreadyApplied ? (
                        <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                      ) : (
                        <Coins className="w-3.5 h-3.5" strokeWidth={2} />
                      )}
                      {busy === c.qbo_payment_id
                        ? "Applying…"
                        : alreadyApplied
                          ? "Applied"
                          : `Apply ${formatCurrency(applyAmount)}`}
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Override section */}
      <div className="pt-3 border-t border-line-soft">
        {overrideOpen ? (
          <div className="space-y-2">
            <div className="text-[11px] text-ink-mute">
              Override when credits are for a different WO / not applicable to this
              invoice. Flips to <code className="text-ink">ready_to_process</code>{" "}
              and future pre_process runs will skip the credit_review flag.
            </div>
            <input
              type="text"
              value={overrideNote}
              onChange={(e) => setOverrideNote(e.target.value)}
              placeholder="Reason (optional) — e.g. credit is for WO 4959388"
              className="w-full bg-bg-elev border border-line rounded-md px-3 py-1.5 text-ink text-sm focus:outline-none focus:border-cyan"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={override} disabled={busy !== null}>
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

      {err && (
        <div className="text-[12px] text-coral bg-coral/[0.06] border border-coral/30 rounded-lg px-3 py-2">
          {err}
        </div>
      )}
    </div>
  )
}

function ReviewReason({ reason }: { reason: string }) {
  // Highlight the most common patterns; fall back to raw text otherwise
  const lower = reason.toLowerCase()
  let tone: "coral" | "sun" | "cyan" = "sun"
  let label: string = reason
  let hint: string | null = null

  if (lower.includes("subtotal_mismatch")) {
    tone = "coral"
    label = "Subtotal mismatch"
    hint =
      "WO and QBO disagree on subtotal — skip if you need to fix in QBO, approve only if you've reconciled manually."
  } else if (lower.includes("memo_low_confidence")) {
    tone = "sun"
    const match = reason.match(/\((\d+)%\)/)
    label = `Memo low confidence${match ? ` (${match[1]}%)` : ""}`
    hint = "Review the memo below — edit if wrong, approve if it's acceptable."
  } else if (lower.includes("memo_api_error")) {
    tone = "coral"
    label = "Claude API error"
    hint = "Hit re-run to retry memo generation."
  } else if (lower.includes("qbo_fetch_failed")) {
    tone = "coral"
    label = "QBO fetch failed"
  } else if (lower.includes("qbo_write_failed")) {
    tone = "coral"
    label = "QBO write failed"
  }

  return (
    <div className="flex items-start gap-3">
      <Pill tone={tone} dot>
        {label}
      </Pill>
      {hint && (
        <div className="text-[11px] text-ink-mute leading-snug">{hint}</div>
      )}
    </div>
  )
}

function ContextBlock({ label, text }: { label: string; text: string }) {
  // Line-clamped to 3 lines by default — keeps the triage card at a
  // consistent initial height so keyboard cycling doesn't make the page
  // jump around. Click "Show more" to expand for long descriptions.
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-ink-mute mb-0.5">
        {label}
      </div>
      <ExpandableText lines={3} className="text-[13px] text-ink-dim leading-relaxed">
        {text}
      </ExpandableText>
    </div>
  )
}

function MetaItem({
  icon: Icon,
  label,
  accent,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  label: string
  /** When true, tints text + icon cyan. Use sparingly — currently only for
   *  "card on file" to signal that this invoice will charge a real card. */
  accent?: boolean
}) {
  const text = accent ? "text-cyan" : "text-ink-dim"
  const icon = accent ? "text-cyan" : "text-ink-mute"
  return (
    <span className={`inline-flex items-center gap-1.5 ${text}`}>
      <Icon className={`w-3 h-3 ${icon}`} strokeWidth={1.8} />
      {label}
    </span>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] uppercase tracking-[0.08em] text-ink-mute">
        {label}
      </label>
      {children}
    </div>
  )
}

function Kbd({ k }: { k: string }) {
  return (
    <kbd className="font-mono bg-bg-elev border border-line rounded px-1 py-0.5 text-[10px] text-ink-dim">
      {k}
    </kbd>
  )
}
