import { HistoryTimeline, type HistoryRow } from "@/components/ui/history-timeline"
import { formatCurrency } from "@/lib/utils/format"
import type {
  InvoiceHistoryEvent,
  InvoiceStreamEvent,
} from "@/lib/queries/dashboard"

/**
 * History — the invoice's activity feed, read from the ADR-010 event stream
 * (public.invoice_events: home events + events naming this invoice as a
 * participant). Row format: short standardized ACTION with linked references,
 * an ACTOR TAG on the right, and detail as subtext or an expandable bullet
 * list (invoice_edited's before→after changes).
 *
 * Lens (deliberate, per EVENT_VOCABULARY "cross-aggregate display"): document
 * lifecycle + money only — created / edited / emailed / applications /
 * charge outcomes / dispositions. Decisions (credit_proposed / rejected) are
 * NOT shown here; they live in the Payments & credits table on the Invoice
 * tab. Legacy process_attempt rows render only until stream charge events
 * exist for this invoice (transitional, until the charge path emits live).
 */

/** Row shape now lives with the shared renderer; the vocabulary stays here. */
type Row = HistoryRow

const qboTxnUrl = (kind: string, id: string) =>
  `https://app.qbo.intuit.com/app/${kind}?txnId=${id}`

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-cyan hover:underline"
    >
      {children}
    </a>
  )
}

/** Actor tag: provenance intent_ref beats raw actor — "who did it" the way
 * Carter reads it (pre-processing, auto-match, QBO, a person, reconciler). */
function tagFor(e: InvoiceStreamEvent): string {
  const ref = e.payload?.provenance?.intent_ref
  if (ref === "pre_process") return "pre-processing"
  // the send runs in the processing stage and passes its stage as intent_ref;
  // it used to fall through to the raw actor and read "auto", which said
  // nothing about which workflow sent the email
  if (ref === "process" || ref === "charge") return "processing"
  if (ref === "bump_due_date") return "processing"
  if (ref === "work_order_link") return "link"
  if (ref?.startsWith("apply_credits/")) {
    const via = ref.split("/")[1]
    return via === "manual" ? "manual" : "auto-match"
  }
  if (e.actor === "qbo_webhook") return "QBO"
  if (e.actor === "reconciler") return "reconciler"
  if (e.actor === "system") return "system"
  if (e.actor.includes("@")) return e.actor.split("@")[0]
  return "auto"
}

function rowFor(e: InvoiceStreamEvent, invoiceId: string): Row | null {
  const base = { key: `s${e.seq}`, at: e.occurred_at, seq: e.seq, tag: tagFor(e) }
  const amt = (n: number | undefined | null) =>
    n != null ? formatCurrency(Number(n)) : null

  switch (e.type) {
    case "invoice_created":
      return { ...base, action: "Invoice created" }
    case "invoice_emailed":
      return { ...base, action: "Invoice emailed" }
    case "invoice_edited":
      return {
        ...base,
        action: "Invoice edited",
        changes: Object.entries(e.payload?.changes ?? {}),
      }
    case "delivery_waived":
      return { ...base, action: "Delivery waived", note: e.payload?.reason ?? null }
    case "payment_applied": {
      const line = e.payload?.lines?.find((l) => l.invoice_id === invoiceId)
      const funding =
        (line as { funding?: { kind: string; id?: string } } | undefined)?.funding ??
        e.payload?.funding
      const isCM = funding?.kind === "credit_memo"
      const cmId = isCM ? (funding?.id ?? "").replace(/^CM-/, "") : null
      const label = (e.payload as { ref?: string | null })?.ref ?? e.aggregate_id
      return {
        ...base,
        action: (
          <>
            Applied {isCM ? "credit memo" : "payment"}{" "}
            {isCM && cmId ? (
              <ExtLink href={qboTxnUrl("creditmemo", cmId)}>#{cmId}</ExtLink>
            ) : (
              <ExtLink href={qboTxnUrl("recvpayment", e.aggregate_id)}>
                #{label}
              </ExtLink>
            )}
            {line ? <span className="text-ink-dim"> · {amt(line.amount)}</span> : null}
          </>
        ),
        note: e.payload?.reason ?? null,
      }
    }
    case "payment_unapplied": {
      const line = e.payload?.lines?.find((l) => l.invoice_id === invoiceId)
      return {
        ...base,
        action: (
          <>
            Unapplied payment{" "}
            <ExtLink href={qboTxnUrl("recvpayment", e.aggregate_id)}>
              #{e.aggregate_id}
            </ExtLink>
            {line ? <span className="text-ink-dim"> · {amt(line.amount)}</span> : null}
          </>
        ),
      }
    }
    case "charge_captured":
      return {
        ...base,
        action: (
          <>
            Charge captured
            <span className="text-ink-dim"> · {amt(e.payload?.amount)}</span>
          </>
        ),
      }
    case "charge_declined":
      return {
        ...base,
        action: "Charge declined",
        note: e.payload?.error ?? null,
      }
    case "charge_uncertain":
      return {
        ...base,
        action: "Charge uncertain",
        note: "outcome unknown — reconciler will confirm",
      }
    case "invoice_written_off":
      return {
        ...base,
        action: (
          <>
            Written off
            <span className="text-ink-dim"> · {amt(e.payload?.amount)}</span>
          </>
        ),
        note: e.payload?.reason ?? null,
      }
    case "invoice_sent_to_collections":
      return { ...base, action: "Sent to collections" }
    case "invoice_recalled_from_collections":
      return { ...base, action: "Recalled from collections" }
    case "receipt_sent":
      // A payment-aggregate event, surfaced here because the customer was
      // emailed about THIS invoice. It reaches us via participants
      // (invoice:<id>), same as charge_captured and payment_applied.
      return {
        ...base,
        action: "Payment receipt emailed",
        note: (e.payload as { email?: string | null })?.email ?? null,
      }
    case "invoice_voided":
      // Discovered, not caused — QBO voided it and the webhook told us. The
      // work_orders in the payload are the ones still claiming this doc
      // number, which is what keeps it in `audit` instead of out of scope.
      return {
        ...base,
        action: "Voided in QBO",
        note: ((e.payload as { work_orders?: string[] })?.work_orders ?? []).length
          ? `still linked to WO ${((e.payload as { work_orders?: string[] }).work_orders ?? []).join(", ")}`
          : null,
      }
    case "invoice_linked":
      return {
        ...base,
        action: "Linked to work order",
        note: (e.payload as { previous_qbo_invoice_id?: string | null })
          ?.previous_qbo_invoice_id
          ? `replaced invoice #${(e.payload as { previous_qbo_invoice_id?: string })
              .previous_qbo_invoice_id}`
          : null,
      }
    // credit_applied is deliberately NOT shown: applying a credit IS
    // payment_applied on the carrier payment, which already renders above with
    // the amount and a QBO link. Emitting both put one application in the
    // timeline twice, from each side.
    // credit_rejected is deliberately NOT shown. It is a DECISION about a
    // credit, already visible in the Payments & credits table with its reason;
    // in the timeline it is noise — a settled invoice emits one per remaining
    // open credit, so a customer with several credits buries the real story.
    // The GATE decision — billing.invoice_ready() saying yes or no. Previously
    // invisible: you could watch the inputs change and the outcome change, but
    // never see the check itself, or why it refused.
    case "invoice_cleared_gate": {
      const checks = Object.entries(
        (e.payload as { checks?: Record<string, boolean> })?.checks ?? {},
      ) as [string, boolean][]
      return {
        ...base,
        action: `Passed readiness check${checks.length ? ` · ${checks.length} rules` : ""}`,
        checks,
      }
    }
    case "invoice_held_for_review": {
      const p = e.payload as { checks?: Record<string, boolean>; reason?: string }
      const checks = Object.entries(p?.checks ?? {}) as [string, boolean][]
      const failed = checks.filter(([, ok]) => !ok).map(([k]) => k)
      return {
        ...base,
        action: `Held for review${failed.length ? ` · ${failed.join(", ")}` : ""}`,
        note: p?.reason ?? null,
        checks,
      }
    }
    case "hold_placed":
      return {
        ...base,
        action: "Held — do not transact",
        note: (e.payload as { reason?: string })?.reason ?? null,
      }
    case "hold_released":
      return {
        ...base,
        action: "Hold released",
        note: (e.payload as { reason?: string })?.reason ?? null,
      }
    // ── queue lifecycle. The stage lives in the payload, not the type, so
    // both queues share these four and read as one continuous story.
    // Queued is NOT shown: being put on a queue is not something that
    // happened to the invoice, and the claim that follows says the same thing
    // with the time that matters.
    case "processing_enqueued":
      return null
    case "processing_claimed":
    case "processing_finished": {
      const p = e.payload as {
        stage?: string
        attempt?: number
        duration_s?: number
        reason?: string
      }
      const stage = p?.stage === "charge" ? "charge" : "preprocess"
      const name = stage === "charge" ? "Processing" : "Pre-processing"
      const edge = e.type === "processing_claimed" ? "start" : "end"
      // The reason outranks the duration: a stage that finished without doing
      // its job is the one thing this marker must not swallow — an invoice
      // parked in needs_review used to end on a silent "PROCESSING DONE".
      const detail =
        edge === "end"
          ? (p?.reason ?? (p?.duration_s != null ? `${p.duration_s}s` : ""))
          : p?.attempt && p.attempt > 1
            ? `attempt ${p.attempt}`
            : ""
      return {
        ...base,
        action: null,
        boundary: {
          stage,
          edge,
          label: edge === "start" ? name : detail ? `${name} · ${detail}` : name,
        },
      }
    }
    case "processing_failed": {
      const p = e.payload as { stage?: string; error?: string; attempt?: number }
      const name = p?.stage === "charge" ? "Processing" : "Pre-processing"
      return {
        ...base,
        action: `${name} failed`,
        note: p?.error ?? null,
      }
    }
    default:
      // outside the lens (birth of payments, cache echoes)
      return null
  }
}

/** Transitional: WAL attempt rows shown only until the stream carries charge
 * events for this invoice — then the stream is the story. */
function legacyChargeRows(events: InvoiceHistoryEvent[]): Row[] {
  return events
    .filter((e) => e.kind.startsWith("process_attempt_"))
    .map((e, i) => ({
      key: `l${i}`,
      at: e.at,
      action: (
        <>
          {e.outcome === "succeeded"
            ? "Charge captured"
            : e.outcome === "charge_declined"
              ? "Charge declined"
              : `Charge ${e.outcome ?? "attempted"}`}
          {e.amount != null && (
            <span className="text-ink-dim"> · {formatCurrency(Number(e.amount))}</span>
          )}
        </>
      ),
      tag: "auto",
      note: e.detail || null,
    }))
}

export function HistoryPanel({
  events,
  stream = [],
}: {
  events: InvoiceHistoryEvent[]
  stream?: InvoiceStreamEvent[]
}) {
  const invoiceId =
    stream.find((e) => e.aggregate === "invoice")?.aggregate_id ??
    events[0]?.qbo_invoice_id ??
    ""
  const streamRows = stream
    .map((e) => rowFor(e, invoiceId))
    .filter((r): r is Row => r !== null)
  const hasStreamCharges = stream.some((e) => e.type.startsWith("charge_"))
  const rows = [
    ...streamRows,
    ...(hasStreamCharges ? [] : legacyChargeRows(events)),
  ].sort((a, b) =>
    a.at !== b.at ? (a.at < b.at ? 1 : -1) : (b.seq ?? 0) - (a.seq ?? 0),
  )

  return <HistoryTimeline rows={rows} title="History" emptyText="No activity yet — nothing has happened to this invoice." />
}
