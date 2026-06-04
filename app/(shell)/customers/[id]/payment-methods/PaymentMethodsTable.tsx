"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Pill } from "@/components/ui/pill"
import { formatDate } from "@/lib/utils/format"
import {
  deactivatePaymentMethod,
  reactivatePaymentMethod,
  type ActionState,
} from "./actions"

export interface PaymentMethodRow {
  id: string
  type: string | null
  card_brand: string | null
  last_four: string | null
  is_default: boolean
  is_active: boolean
  deactivated_at: string | null
  fetched_at: string
}

interface Props {
  rows: PaymentMethodRow[]
  /** public.Customers.id — used for the revalidatePath round-trip. */
  customerId: string
  canWrite: boolean
}

const empty: ActionState = {}

export function PaymentMethodsTable({ rows, customerId, canWrite }: Props) {
  if (rows.length === 0) {
    return (
      <div className="text-ink-mute text-sm border border-line-soft rounded-lg p-4 bg-bg-elev/40">
        No payment methods on file from QBO for this customer.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <Row key={row.id} row={row} customerId={customerId} canWrite={canWrite} />
      ))}
    </div>
  )
}

function Row({
  row,
  customerId,
  canWrite,
}: {
  row: PaymentMethodRow
  customerId: string
  canWrite: boolean
}) {
  const isUserDeactivated = row.deactivated_at !== null
  const isQboInactive = !row.is_active

  return (
    <div className="border border-line-soft rounded-lg p-3 bg-bg-elev/40 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-ink">
            {prettyType(row.type)}
            {row.card_brand ? ` · ${row.card_brand}` : ""}
            {row.last_four ? ` ····${row.last_four}` : ""}
          </span>
          {row.is_default && <Pill tone="cyan">QBO default</Pill>}
          {isQboInactive && <Pill tone="sun">Removed in QBO</Pill>}
          {isUserDeactivated && <Pill tone="coral">User-deactivated</Pill>}
          {!isQboInactive && !isUserDeactivated && <Pill tone="grass">Usable</Pill>}
        </div>
        <div className="text-ink-mute text-xs">
          Last synced {formatDate(row.fetched_at)}
          {isUserDeactivated && (
            <> · Deactivated {formatDate(row.deactivated_at!)}</>
          )}
        </div>
      </div>
      {canWrite && (
        <div className="shrink-0">
          {isUserDeactivated ? (
            <ReactivateForm pmId={row.id} customerId={customerId} />
          ) : (
            <DeactivateForm pmId={row.id} customerId={customerId} />
          )}
        </div>
      )}
    </div>
  )
}

function DeactivateForm({ pmId, customerId }: { pmId: string; customerId: string }) {
  const [state, action, pending] = useActionState(deactivatePaymentMethod, empty)
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="payment_method_id" value={pmId} />
      <input type="hidden" name="customer_id" value={customerId} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Deactivating…" : "Deactivate"}
      </Button>
      {state.error && <p className="text-coral text-xs">{state.error}</p>}
      {state.ok && <p className="text-grass text-xs">{state.ok}</p>}
    </form>
  )
}

function ReactivateForm({ pmId, customerId }: { pmId: string; customerId: string }) {
  const [state, action, pending] = useActionState(reactivatePaymentMethod, empty)
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="payment_method_id" value={pmId} />
      <input type="hidden" name="customer_id" value={customerId} />
      <Button type="submit" size="sm" variant="primary" disabled={pending}>
        {pending ? "Reactivating…" : "Reactivate"}
      </Button>
      {state.error && <p className="text-coral text-xs">{state.error}</p>}
      {state.ok && <p className="text-grass text-xs">{state.ok}</p>}
    </form>
  )
}

function prettyType(type: string | null): string {
  if (!type) return "Payment method"
  if (type === "credit_card") return "Credit card"
  if (type === "ach") return "ACH"
  if (type === "check") return "Check"
  return type
}
