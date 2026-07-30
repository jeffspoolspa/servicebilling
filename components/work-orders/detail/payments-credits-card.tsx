"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { ColumnDef } from "@tanstack/react-table"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { Dialog } from "@/components/ui/dialog"
import { Pill } from "@/components/ui/pill"
import { formatCurrency, formatDate } from "@/lib/utils/format"
import type {
  AppliedPayment,
  CreditDecision,
  OpenCredit,
} from "@/lib/queries/dashboard"

/**
 * Payments & credits — ONE standardized DataTable over what used to be two
 * tabs. Every open payment/credit gets recommended; each row shows its
 * OUTCOME, when it last changed, and who moved it. Rows are uniform height —
 * no subtext under values; full detail (match reason, memo, funding) lives in
 * the row-click modal. THE LEDGER OUTRANKS THE DECISION: a
 * payment_invoice_links row means applied, even over a stale open proposal.
 */

type RowT = {
  key: string
  paymentId: string
  ref: string | null
  kind: "payment" | "credit_memo"
  amount: number | null
  outcome: "to_decide" | "applied" | "rejected" | "lapsed"
  lastUpdated: string | null
  by: string
  reason: string | null
  memo: string | null
  via: string | null
}

const qboUrl = (kind: RowT["kind"], id: string) =>
  kind === "credit_memo"
    ? `https://app.qbo.intuit.com/app/creditmemo?txnId=${id.replace(/^CM-/, "")}`
    : `https://app.qbo.intuit.com/app/recvpayment?txnId=${id}`

const OUTCOME: Record<RowT["outcome"], { label: string; tone: "sun" | "grass" | "neutral" }> = {
  to_decide: { label: "to decide", tone: "sun" },
  applied: { label: "applied", tone: "grass" },
  rejected: { label: "not applicable", tone: "neutral" },
  lapsed: { label: "lapsed", tone: "neutral" },
}

/** Who moved the row to its outcome — short standardized tags. */
function byLabel(via: string | null, decidedBy: string | null): string {
  const v = via ?? decidedBy
  if (!v) return "—"
  if (v === "external_qbo") return "QBO"
  if (v === "pre_process") return "pre-processing"
  if (v === "review_complete") return "review"
  if (v === "auto_match" || v === "auto") return "auto"
  if (v.includes("@")) return v.split("@")[0]
  return v.replace(/_/g, " ")
}

export function PaymentsCreditsCard({
  qboInvoiceId,
  balance,
  openCredits,
  decisions,
  appliedPayments,
}: {
  qboInvoiceId: string
  balance: number
  openCredits: OpenCredit[]
  decisions: CreditDecision[]
  appliedPayments: AppliedPayment[]
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<RowT | null>(null)

  const creditById = new Map(openCredits.map((c) => [c.qbo_payment_id, c]))
  const appliedById = new Map(appliedPayments.map((p) => [p.payment_id, p]))
  const decidedIds = new Set(decisions.map((d) => d.credit_id))

  const rows: RowT[] = [
    ...decisions.map((d): RowT => {
      const c = creditById.get(d.credit_id)
      const ap = appliedById.get(d.credit_id)
      const applied = ap != null || d.state === "applied"
      return {
        key: `d${d.id}`,
        paymentId: d.credit_id,
        ref: c?.ref_num ?? ap?.ref_num ?? null,
        kind: (c?.type ?? ap?.type ?? "payment") === "credit_memo" ? "credit_memo" : "payment",
        amount: applied ? (ap?.amount ?? d.amount) : (d.amount ?? c?.unapplied_amt ?? null),
        outcome:
          applied ? "applied"
          : d.state === "rejected" ? "rejected"
          : d.state === "stale" ? "lapsed"
          : "to_decide",
        lastUpdated: ap?.applied_at ?? d.decided_at ?? d.created_at,
        by: byLabel(ap?.applied_via ?? d.applied_via, d.decided_by),
        reason: d.reason,
        memo: c?.memo ?? ap?.memo ?? null,
        via: ap?.applied_via ?? d.applied_via ?? d.decided_by,
      }
    }),
    ...openCredits
      .filter((c) => !decidedIds.has(c.qbo_payment_id))
      .map((c): RowT => ({
        key: `c${c.qbo_payment_id}`,
        paymentId: c.qbo_payment_id,
        ref: c.ref_num,
        kind: c.type === "credit_memo" ? "credit_memo" : "payment",
        amount: c.unapplied_amt,
        outcome: "to_decide",
        lastUpdated: c.txn_date,
        by: "—",
        reason: null,
        memo: c.memo,
        via: null,
      })),
    ...appliedPayments
      .filter((p) => !decidedIds.has(p.payment_id))
      .map((p): RowT => ({
        key: `p${p.payment_id}`,
        paymentId: p.payment_id,
        ref: p.ref_num,
        kind: p.type === "credit_memo" ? "credit_memo" : "payment",
        amount: p.amount,
        outcome: "applied",
        lastUpdated: p.applied_at,
        by: byLabel(p.applied_via, null),
        reason: null,
        memo: p.memo,
        via: p.applied_via,
      })),
  ]

  const pending = rows.filter((r) => r.outcome === "to_decide").length

  async function post(url: string, body: unknown, key: string) {
    setBusy(key)
    setError(null)
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({ error: "failed" }))
        throw new Error(msg || `${res.status}`)
      }
      startTransition(() => router.refresh())
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed")
    } finally {
      setBusy(null)
    }
  }

  const apiBase = `/api/billing/invoices/${qboInvoiceId}`

  const columns: ColumnDef<RowT>[] = [
    {
      id: "payment",
      accessorFn: (r) => r.ref ?? r.paymentId,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Payment" />,
      cell: ({ row }) => (
        <a
          href={qboUrl(row.original.kind, row.original.paymentId)}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-cyan hover:underline"
        >
          #{row.original.ref ?? row.original.paymentId}
        </a>
      ),
    },
    {
      id: "type",
      accessorFn: (r) => (r.kind === "credit_memo" ? "credit memo" : "payment"),
      header: "Type",
      cell: ({ getValue }) => <span className="text-ink-dim">{getValue<string>()}</span>,
    },
    {
      id: "amount",
      accessorFn: (r) => r.amount,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Amount" />,
      meta: { align: "right" },
      cell: ({ row }) =>
        row.original.amount != null ? (
          <span className="num text-ink">{formatCurrency(Number(row.original.amount))}</span>
        ) : (
          "—"
        ),
    },
    {
      id: "outcome",
      accessorFn: (r) => OUTCOME[r.outcome].label,
      header: "Outcome",
      cell: ({ row }) => {
        const o = OUTCOME[row.original.outcome]
        return (
          <Pill tone={o.tone} dot className="text-[10px]">
            {o.label}
          </Pill>
        )
      },
    },
    {
      id: "updated",
      accessorFn: (r) => r.lastUpdated,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Last updated" />,
      cell: ({ row }) => (
        <span className="text-ink-dim">
          {row.original.lastUpdated ? formatDate(row.original.lastUpdated) : "—"}
        </span>
      ),
    },
    {
      id: "by",
      accessorFn: (r) => r.by,
      header: "By",
      cell: ({ getValue }) => (
        <span className="text-[10px] text-ink-mute border border-line-soft rounded-full px-1.5 py-px">
          {getValue<string>()}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) =>
        row.original.outcome === "to_decide" ? (
          <div className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() =>
                post(
                  `${apiBase}/apply-credit`,
                  {
                    credit_id: row.original.paymentId,
                    ...(row.original.amount != null
                      ? { amount: Math.min(Number(row.original.amount), balance) }
                      : {}),
                  },
                  `apply:${row.original.paymentId}`,
                )
              }
              disabled={busy !== null || balance <= 0}
              className="text-[11px] text-cyan border border-cyan/40 bg-cyan/10 rounded-md px-2 py-0.5 hover:bg-cyan/20 disabled:opacity-50"
            >
              {busy === `apply:${row.original.paymentId}` ? "Applying…" : "Apply"}
            </button>
            <button
              onClick={() =>
                post(`${apiBase}/reject-credit`, { credit_id: row.original.paymentId },
                  `reject:${row.original.paymentId}`)
              }
              disabled={busy !== null}
              className="ml-1.5 text-[11px] text-ink-mute hover:text-ink disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        ) : null,
    },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments &amp; credits</CardTitle>
        <div className="ml-auto flex items-center gap-2">
          {pending > 0 && (
            <>
              <Pill tone="sun" dot className="text-[10px]">
                {pending} to decide
              </Pill>
              <button
                onClick={() => post(`${apiBase}/complete-credit-review`, {}, "complete")}
                disabled={busy !== null}
                className="text-[11px] text-ink-mute border border-line-soft rounded-md px-2 py-0.5 hover:text-ink disabled:opacity-50"
                title="Mark every undecided credit not applicable and complete the review"
              >
                {busy === "complete" ? "Completing…" : "Complete review"}
              </button>
            </>
          )}
        </div>
      </CardHeader>
      <CardBody>
        <DataTable
          columns={columns}
          data={rows}
          pageSize={10}
          initialSorting={[{ id: "updated", desc: true }]}
          emptyText="No payments or credits touch this invoice."
          csvFilename={false}
          onRowClick={setDetail}
        />
        {error && (
          <div className="mt-2 text-[11px] text-coral bg-coral/[0.06] border border-coral/30 rounded px-2.5 py-1.5">
            {error}
          </div>
        )}
      </CardBody>

      {/* row detail — modal (doesn't justify its own page) */}
      <Dialog
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail ? `${detail.kind === "credit_memo" ? "Credit memo" : "Payment"} #${detail.ref ?? detail.paymentId}` : ""}
      >
        {detail && (
          <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2 text-[12px]">
            <dt className="text-ink-mute">QBO id</dt>
            <dd>
              <a
                href={qboUrl(detail.kind, detail.paymentId)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-cyan hover:underline"
              >
                {detail.paymentId}
              </a>
            </dd>
            <dt className="text-ink-mute">Amount</dt>
            <dd className="num text-ink">
              {detail.amount != null ? formatCurrency(Number(detail.amount)) : "—"}
            </dd>
            <dt className="text-ink-mute">Outcome</dt>
            <dd>
              <Pill tone={OUTCOME[detail.outcome].tone} dot className="text-[10px]">
                {OUTCOME[detail.outcome].label}
              </Pill>
            </dd>
            <dt className="text-ink-mute">Last updated</dt>
            <dd className="text-ink">
              {detail.lastUpdated ? formatDate(detail.lastUpdated) : "—"}
            </dd>
            <dt className="text-ink-mute">By</dt>
            <dd className="text-ink">{detail.by}</dd>
            {detail.reason && (
              <>
                <dt className="text-ink-mute">Match reason</dt>
                <dd className="text-ink">{detail.reason.replace(/_/g, " ")}</dd>
              </>
            )}
            {detail.memo && (
              <>
                <dt className="text-ink-mute">Memo</dt>
                <dd className="text-ink-dim">{detail.memo}</dd>
              </>
            )}
          </dl>
        )}
      </Dialog>
    </Card>
  )
}
