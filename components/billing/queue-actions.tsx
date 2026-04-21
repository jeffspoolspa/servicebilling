"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { SortableHeader } from "@/components/ui/sortable-header"
import { CreditCard, Eye, X } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils/format"
import { BatchProgressModal, type BatchInvoiceSummary } from "./batch-progress-modal"

/**
 * Bulk-select + Process Selected / Dry-run Selected for the billing queue.
 *
 * Owns the selection state and renders the table body with a checkbox column.
 * Headers + page chrome stay in the server component.
 *
 * The confirmation step for LIVE processing requires the user to type the literal
 * string "CHARGE" — guards against accidental clicks since real money moves.
 */

export interface QueueRow {
  wo_number: string
  invoice_number: string | null
  qbo_invoice_id: string | null
  customer: string | null
  type: string | null
  qbo_class: string | null
  payment_method: string | null
  assigned_to: string | null
  office_name: string | null
  qbo_email_status: string | null
  qbo_balance: number | string | null
  completed: string | null
  total_due: number | string | null
}

interface Props {
  rows: QueueRow[]
  /** Current sort column — drives SortableHeader chevrons. Omit to disable sort UI. */
  sort?: string
  dir?: "asc" | "desc"
  /** URL params to preserve when sort changes. */
  preserve?: Record<string, string | undefined>
  /** Base path for the sort links. Defaults to /service-billing/queue. */
  basePath?: string
}

export function QueueActions({
  rows,
  sort,
  dir,
  preserve,
  basePath = "/service-billing/queue",
}: Props) {
  // If the page didn't pass sort state, render plain headers. Otherwise wire
  // SortableHeader so clicks round-trip through the URL.
  const sortable = sort !== undefined && dir !== undefined
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showConfirm, setShowConfirm] = useState<"live" | null>(null)
  const [confirmText, setConfirmText] = useState("")
  const [busy, setBusy] = useState<"dry" | "live" | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Batch progress modal — opens after firing the script. We snapshot the
  // invoice metadata AT FIRE TIME so the modal has stable labels even if the
  // parent page refetches.
  const [batchModal, setBatchModal] = useState<{
    open: boolean
    invoices: BatchInvoiceSummary[]
    dryRun: boolean
    triggeredAt: number | null
  }>({ open: false, invoices: [], dryRun: false, triggeredAt: null })

  // Only rows with a qbo_invoice_id are actually processable (the script keys on it)
  const selectableRows = useMemo(
    () => rows.filter((r) => r.qbo_invoice_id != null),
    [rows],
  )

  const allSelected = selectableRows.length > 0 && selected.size === selectableRows.length
  const someSelected = selected.size > 0 && !allSelected

  function toggleRow(qboInvoiceId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(qboInvoiceId)) next.delete(qboInvoiceId)
      else next.add(qboInvoiceId)
      return next
    })
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(selectableRows.map((r) => r.qbo_invoice_id as string)))
    }
  }

  const selectedRows = selectableRows.filter((r) =>
    selected.has(r.qbo_invoice_id as string),
  )
  const selectedTotal = selectedRows.reduce(
    (acc, r) => acc + Number(r.qbo_balance ?? 0),
    0,
  )
  const selectedOnFile = selectedRows.filter((r) => r.payment_method === "on_file").length
  const selectedInvoiceOnly = selectedRows.length - selectedOnFile

  async function fire(dry: boolean) {
    setBusy(dry ? "dry" : "live")
    setErrorMsg(null)
    try {
      const ids = selectedRows
        .map((r) => r.qbo_invoice_id)
        .filter((id): id is string => Boolean(id))

      if (ids.length === 0) {
        throw new Error("No qbo_invoice_id present on selected rows. UI integration bug.")
      }

      // Snapshot the invoice metadata for the modal BEFORE firing — this way
      // the modal has stable labels even if the background page refetches.
      const modalInvoices: BatchInvoiceSummary[] = selectedRows.map((r) => ({
        qbo_invoice_id: r.qbo_invoice_id as string,
        doc_number: r.invoice_number,
        customer_name: r.customer,
        balance: Number(r.qbo_balance ?? 0),
        payment_method: r.payment_method,
        wo_number: r.wo_number,
      }))

      const resp = await fetch("/api/billing/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qbo_invoice_ids: ids, dry_run: dry }),
      })

      if (!resp.ok) {
        const txt = await resp.text()
        throw new Error(txt.slice(0, 300) || `HTTP ${resp.status}`)
      }
      // Close confirmation modal, open progress modal
      setShowConfirm(null)
      setConfirmText("")
      setBatchModal({
        open: true,
        invoices: modalInvoices,
        dryRun: dry,
        triggeredAt: Date.now(),
      })
      setSelected(new Set())
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "unknown error")
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {/* Header row: select-all + count chip */}
      <div className="flex items-center gap-3 px-5 py-2 border-b border-line-soft bg-[#0c1926]">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected
          }}
          onChange={toggleAll}
          className="cursor-pointer accent-cyan"
          aria-label="Select all on this page"
        />
        <span className="text-[11px] text-ink-mute">
          {selected.size > 0
            ? `${selected.size} of ${selectableRows.length} selected · ${formatCurrency(selectedTotal)}`
            : `${selectableRows.length} on this page · click to select`}
        </span>
      </div>

      {/* Table — adds a checkbox column to the server-rendered structure */}
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.12em] border-b border-line-soft bg-[#0c1926]">
              <th className="w-8 px-3 py-2.5"></th>
              <HeaderCell label="WO" column="wo_number" sortable={sortable} sort={sort} dir={dir} preserve={preserve} basePath={basePath} defaultDir="asc" />
              <HeaderCell label="Invoice" column="invoice_number" sortable={sortable} sort={sort} dir={dir} preserve={preserve} basePath={basePath} defaultDir="asc" />
              <HeaderCell label="Customer" column="customer" sortable={sortable} sort={sort} dir={dir} preserve={preserve} basePath={basePath} defaultDir="asc" />
              <HeaderCell label="Class" column="qbo_class" sortable={sortable} sort={sort} dir={dir} preserve={preserve} basePath={basePath} defaultDir="asc" />
              <HeaderCell label="Method" column="payment_method" sortable={sortable} sort={sort} dir={dir} preserve={preserve} basePath={basePath} defaultDir="asc" />
              <HeaderCell label="Tech" column="assigned_to" sortable={sortable} sort={sort} dir={dir} preserve={preserve} basePath={basePath} defaultDir="asc" />
              <HeaderCell label="Sent" column="qbo_email_status" sortable={sortable} sort={sort} dir={dir} preserve={preserve} basePath={basePath} defaultDir="asc" />
              <HeaderCell label="Balance" column="qbo_balance" sortable={sortable} sort={sort} dir={dir} preserve={preserve} basePath={basePath} className="num" />
              <HeaderCell label="Completed" column="completed" sortable={sortable} sort={sort} dir={dir} preserve={preserve} basePath={basePath} />
              <HeaderCell label="Total" column="total_due" sortable={sortable} sort={sort} dir={dir} preserve={preserve} basePath={basePath} align="right" className="num pr-5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const qid = row.qbo_invoice_id ?? ""
              const isSelected = selected.has(qid)
              const canSelect = qid !== ""
              return (
                <tr
                  key={row.wo_number}
                  className={`border-b border-line-soft hover:bg-white/[0.03] transition-colors ${
                    isSelected ? "bg-cyan/[0.04]" : ""
                  }`}
                >
                  <td className="px-3 py-2.5">
                    {canSelect && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRow(qid)}
                        className="cursor-pointer accent-cyan"
                        aria-label={`Select WO ${row.wo_number}`}
                      />
                    )}
                  </td>
                  <td className="px-5 py-2.5 font-mono">
                    <Link
                      href={`/work-orders/${row.wo_number}` as never}
                      className="text-cyan hover:underline"
                    >
                      {row.wo_number}
                    </Link>
                  </td>
                  <td className="font-mono text-ink-dim text-xs">{row.invoice_number}</td>
                  <td className="text-ink truncate max-w-[200px]">{row.customer ?? "—"}</td>
                  <td className="text-ink-dim text-xs">{row.qbo_class ?? "—"}</td>
                  <td className="text-xs">
                    {row.payment_method === "on_file" ? (
                      <span className="text-cyan">On file</span>
                    ) : (
                      <span className="text-ink-mute">Invoice</span>
                    )}
                  </td>
                  <td className="text-ink-mute text-xs font-mono">
                    {row.assigned_to?.split(",")[1]?.trim() ?? row.assigned_to ?? "—"}
                  </td>
                  <td className="text-xs">
                    {row.qbo_email_status === "EmailSent" ? (
                      <span className="text-teal">sent</span>
                    ) : (
                      <span className="text-ink-mute">—</span>
                    )}
                  </td>
                  <td className="text-xs num">
                    {Number(row.qbo_balance ?? 0) === 0 ? (
                      <span className="text-grass">paid</span>
                    ) : (
                      <span className="text-sun">
                        {formatCurrency(Number(row.qbo_balance ?? 0))}
                      </span>
                    )}
                  </td>
                  <td className="text-ink-mute text-xs">{formatDate(row.completed)}</td>
                  <td className="num text-right pr-5 text-ink">
                    {formatCurrency(Number(row.total_due ?? 0))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="px-5 py-12 text-center text-ink-mute text-sm">
            Nothing ready to process.
          </div>
        )}
      </div>

      {/* Sticky action bar — shows when something is selected */}
      {selected.size > 0 && (
        <div className="fixed bottom-0 left-[244px] right-0 z-20 border-t border-line bg-[#0A1622]/95 backdrop-blur-md px-7 py-3 flex items-center gap-4 shadow-[0_-4px_12px_rgba(0,0,0,0.3)]">
          <button
            onClick={() => setSelected(new Set())}
            className="text-ink-mute hover:text-ink transition-colors"
            aria-label="Clear selection"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="text-sm">
            <span className="text-ink font-medium">
              {selected.size} selected · {formatCurrency(selectedTotal)}
            </span>
            <span className="text-ink-mute text-xs ml-3">
              {selectedOnFile} on-file · {selectedInvoiceOnly} invoice-only
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {errorMsg && (
              <span
                className="text-xs text-coral max-w-[400px] truncate"
                title={errorMsg}
              >
                {errorMsg}
              </span>
            )}
            <Button
              size="sm"
              variant="default"
              onClick={() => fire(true)}
              disabled={busy !== null}
            >
              <Eye className="w-3.5 h-3.5" strokeWidth={2} />
              {busy === "dry" ? "Queueing dry-run..." : "Dry-run Selected"}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => setShowConfirm("live")}
              disabled={busy !== null}
            >
              <CreditCard className="w-3.5 h-3.5" strokeWidth={2} />
              {busy === "live" ? "Processing..." : `Process ${selected.size}`}
            </Button>
          </div>
        </div>
      )}

      {/* Live progress modal — opens after script fires, watches DB state */}
      <BatchProgressModal
        open={batchModal.open}
        onClose={() => setBatchModal((m) => ({ ...m, open: false }))}
        invoices={batchModal.invoices}
        dryRun={batchModal.dryRun}
        triggeredAt={batchModal.triggeredAt}
      />

      {/* Live confirmation modal — type CHARGE to enable button */}
      {showConfirm === "live" && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm grid place-items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowConfirm(null)
              setConfirmText("")
            }
          }}
        >
          <div className="bg-[#0E1C2A] border border-line rounded-xl shadow-2xl max-w-md w-full mx-6 p-6 space-y-4">
            <h3 className="text-lg font-medium text-ink">Process {selected.size} invoice(s)?</h3>
            <div className="text-sm text-ink-dim space-y-2">
              <p>
                This will <span className="text-coral font-medium">charge real cards</span>{" "}
                via QBO Payments and send invoice emails. Action is logged but charges
                cannot be undone from this UI — refunds must be done in QBO.
              </p>
              <div className="bg-bg-elev rounded-lg p-3 space-y-1 font-mono text-xs">
                <div>
                  <span className="text-ink-mute">Total to charge:</span>{" "}
                  <span className="text-sun font-medium">{formatCurrency(selectedTotal)}</span>
                </div>
                <div>
                  <span className="text-ink-mute">Cards on file:</span>{" "}
                  <span className="text-cyan">{selectedOnFile}</span>
                </div>
                <div>
                  <span className="text-ink-mute">Invoice-only (email):</span>{" "}
                  <span className="text-ink">{selectedInvoiceOnly}</span>
                </div>
              </div>
              <p className="text-xs">
                Type{" "}
                <code className="bg-bg-elev px-1.5 py-0.5 rounded text-coral">CHARGE</code>{" "}
                below to enable the button.
              </p>
            </div>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoFocus
              placeholder="Type CHARGE"
              className="w-full bg-bg-elev border border-line rounded-md px-3 py-2 text-sm text-ink font-mono focus:outline-none focus:border-cyan"
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowConfirm(null)
                  setConfirmText("")
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => fire(false)}
                disabled={confirmText !== "CHARGE" || busy !== null}
              >
                {busy === "live" ? "Processing..." : `Charge ${formatCurrency(selectedTotal)}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Header cell that renders a SortableHeader when sort state is provided, or
// a plain static header otherwise. Keeps the thead markup tight.
function HeaderCell({
  label,
  column,
  sortable,
  sort,
  dir,
  preserve,
  basePath,
  defaultDir = "desc",
  align = "left",
  className = "",
}: {
  label: string
  column: string
  sortable: boolean
  sort?: string
  dir?: "asc" | "desc"
  preserve?: Record<string, string | undefined>
  basePath: string
  defaultDir?: "asc" | "desc"
  align?: "left" | "right"
  className?: string
}) {
  const alignClass = align === "right" ? "text-right" : "text-left"
  return (
    <th className={`px-5 py-2.5 font-medium ${alignClass} ${className}`}>
      {sortable ? (
        <SortableHeader
          label={label}
          column={column}
          currentSort={sort!}
          currentDir={dir!}
          basePath={basePath}
          preserve={preserve}
          defaultDir={defaultDir}
          align={align}
        />
      ) : (
        label
      )}
    </th>
  )
}
