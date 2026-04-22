"use client"

import { useActionState, useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Plus, Trash2 } from "lucide-react"
import type { SignOutItem } from "@/lib/entities/inventory-signout/types"
import {
  SIGNOUT_CATEGORIES,
  SIGNOUT_CATEGORY_LABELS,
} from "@/lib/entities/inventory-signout/signout-items"
import { submitSignOut, type SubmitState } from "./actions"

interface Row {
  itemId: string
  qty: string
}

const blankRow = (): Row => ({ itemId: "", qty: "" })
const initial: SubmitState = {}

interface Props {
  employeeName: string
  items: SignOutItem[]
  prefillIds?: number[]
}

function pluralize(word: string, n: number) {
  if (n === 1) return word
  if (word.endsWith("y")) return word.slice(0, -1) + "ies"
  return word + "s"
}

function isBulkItem(item: SignOutItem | undefined) {
  return Boolean(item && item.multiplier > 1 && item.input_unit)
}

/** For bulk items, qty is implicitly "1"; only non-bulk items need explicit qty > 0. */
function isRowValid(row: Row, items: SignOutItem[]): boolean {
  if (!row.itemId) return false
  const item = items.find((i) => i.id === Number(row.itemId))
  if (!item) return false
  if (isBulkItem(item)) return true
  return Number(row.qty) > 0
}

export function SignOutForm({ employeeName, items, prefillIds = [] }: Props) {
  const initialRows: Row[] =
    prefillIds.length > 0
      ? prefillIds.map((id) => {
          const item = items.find((i) => i.id === id)
          // Non-bulk items default to qty 1; bulk items submit as 1 container implicitly.
          const qty = item && !isBulkItem(item) ? "1" : ""
          return { itemId: String(id), qty }
        })
      : [blankRow()]
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [state, formAction, pending] = useActionState(submitSignOut, initial)
  const [showToast, setShowToast] = useState(false)
  const lastResult = useRef(state)

  useEffect(() => {
    if (state !== lastResult.current) {
      lastResult.current = state
      if (state.ok) {
        setRows([blankRow()])
        setShowToast(true)
        const t = setTimeout(() => setShowToast(false), 2500)
        return () => clearTimeout(t)
      }
    }
  }, [state])

  const valid = rows.length > 0 && rows.every((r) => isRowValid(r, items))

  const payload = JSON.stringify({
    rows: rows
      .filter((r) => isRowValid(r, items))
      .map((r) => {
        const item = items.find((i) => i.id === Number(r.itemId))
        return {
          item_id: Number(r.itemId),
          quantity: isBulkItem(item) ? 1 : Number(r.qty),
        }
      }),
  })

  if (items.length === 0) {
    return (
      <div className="text-coral text-sm border border-coral/20 bg-coral/5 rounded-lg p-3.5">
        No items are currently enabled for sign-out. Ask an admin to update the item allowlist.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="text-sm text-ink-dim">
        Signing out as <span className="text-ink font-medium">{employeeName}</span>.
      </div>

      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="payload" value={payload} />

        {rows.map((row, idx) => {
          const selected = row.itemId
            ? items.find((i) => i.id === Number(row.itemId))
            : undefined
          const bulk = isBulkItem(selected)
          const qtyNum = Number(row.qty) || 0

          return (
            <div
              key={idx}
              className="flex gap-2 items-start border border-line-soft rounded-lg p-3 bg-bg-elev/40"
            >
              <div className="flex-1 flex flex-col gap-2">
                <select
                  required
                  value={row.itemId}
                  onChange={(e) =>
                    setRows((rs) =>
                      rs.map((r, i) => (i === idx ? { ...r, itemId: e.target.value } : r)),
                    )
                  }
                  className="bg-[#0E1C2A] border border-line rounded-lg px-3 py-2.5 text-base text-ink min-h-11 focus:border-cyan focus:outline-none"
                >
                  <option value="">Select item…</option>
                  {SIGNOUT_CATEGORIES.map((cat) => {
                    const group = items.filter((it) => it.category === cat)
                    if (group.length === 0) return null
                    return (
                      <optgroup key={cat} label={SIGNOUT_CATEGORY_LABELS[cat]}>
                        {group.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.display_name}
                          </option>
                        ))}
                      </optgroup>
                    )
                  })}
                </select>

                {bulk && selected ? (
                  <div className="text-ink-dim text-sm">
                    1 {selected.input_unit}
                    {selected.stock_unit ? (
                      <span className="text-ink-mute">
                        {" "}
                        · {selected.multiplier} {pluralize(selected.stock_unit, selected.multiplier)}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      required
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="any"
                      placeholder="Quantity"
                      value={row.qty}
                      onChange={(e) =>
                        setRows((rs) =>
                          rs.map((r, i) =>
                            i === idx ? { ...r, qty: e.target.value } : r,
                          ),
                        )
                      }
                      className="flex-1 bg-[#0E1C2A] border border-line rounded-lg px-3 py-2.5 text-base text-ink min-h-11 focus:border-cyan focus:outline-none"
                    />
                    {selected?.stock_unit && qtyNum > 0 && (
                      <span className="text-ink-dim text-sm whitespace-nowrap">
                        {pluralize(selected.stock_unit, qtyNum)}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() =>
                  setRows((rs) =>
                    rs.length === 1 ? [blankRow()] : rs.filter((_, i) => i !== idx),
                  )
                }
                aria-label="Remove row"
                className="text-ink-mute hover:text-coral p-2 rounded-lg transition-colors"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          )
        })}

        <button
          type="button"
          onClick={() => setRows((rs) => [...rs, blankRow()])}
          className="flex items-center justify-center gap-2 text-cyan text-sm py-2.5 border border-dashed border-cyan/30 rounded-lg hover:bg-cyan/5 transition-colors"
        >
          <Plus className="w-4 h-4" /> Add another item
        </button>

        {state.error && <p className="text-coral text-sm">{state.error}</p>}

        <Button
          type="submit"
          variant="primary"
          disabled={!valid || pending}
          className="h-12 text-base mt-1"
        >
          {pending ? "Saving…" : "Submit sign-out"}
        </Button>
      </form>

      {showToast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 bg-grass/10 border border-grass/30 text-grass text-sm px-4 py-2.5 rounded-lg shadow-card">
          Sign-out saved.
        </div>
      )}
    </div>
  )
}
