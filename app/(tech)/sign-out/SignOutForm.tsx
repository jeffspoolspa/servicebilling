"use client"

import { useActionState, useState, useEffect, useRef } from "react"
import { Minus, Plus, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { SignOutItem } from "@/lib/entities/inventory-signout/types"
import { submitSignOut, type SubmitState } from "./actions"
import { ItemPicker } from "./ItemPicker"

interface Row {
  itemId: string
  qty: string
}

const blankRow = (): Row => ({ itemId: "", qty: "1" })
const initial: SubmitState = {}

interface Props {
  employeeName: string
  items: SignOutItem[]
  prefillIds?: number[]
}

// Inline cyan chevron for native <select>. Applied as a style prop to avoid
// Tailwind's arbitrary-value URL escaping getting mangled by PostCSS.
const SELECT_CHEVRON_STYLE: React.CSSProperties = {
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'><path d='M1 1.5 L6 6.5 L11 1.5' stroke='%2338bdf8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 14px center",
  backgroundSize: "12px 8px",
}

function pluralize(word: string, n: number) {
  if (n === 1) return word
  if (word.endsWith("y")) return word.slice(0, -1) + "ies"
  return word + "s"
}

function isBulkItem(item: SignOutItem | undefined) {
  return Boolean(item && item.multiplier > 1 && item.input_unit)
}

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
      ? prefillIds.map((id) => ({ itemId: String(id), qty: "1" }))
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
          const canRemove = rows.length > 1

          const trashBtn = (
            <button
              type="button"
              onClick={() =>
                setRows((rs) =>
                  rs.length === 1 ? [blankRow()] : rs.filter((_, i) => i !== idx),
                )
              }
              aria-label={canRemove ? "Remove item" : "Clear item"}
              className={cn(
                "shrink-0 w-11 h-11 grid place-items-center rounded-lg",
                "text-ink-mute hover:text-coral hover:bg-coral/10",
                "transition-[color,background-color,transform] duration-150 ease-out",
                "active:scale-[0.92]",
              )}
            >
              <Trash2 className="w-4 h-4" strokeWidth={1.8} />
            </button>
          )

          return (
            <div
              key={idx}
              className="rounded-xl p-3 bg-bg-elev/60 border border-line-soft flex flex-col gap-2"
            >
              <ItemPicker
                items={items}
                value={row.itemId}
                onChange={(next) =>
                  setRows((rs) =>
                    rs.map((r, i) => (i === idx ? { ...r, itemId: next } : r)),
                  )
                }
                chevronStyle={SELECT_CHEVRON_STYLE}
              />

              {bulk && selected ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1 flex items-baseline gap-1.5 text-sm">
                    <span className="text-ink">1 {selected.input_unit}</span>
                    {selected.stock_unit && (
                      <span className="text-ink-mute">
                        · {selected.multiplier} {pluralize(selected.stock_unit, selected.multiplier)}
                      </span>
                    )}
                  </div>
                  {trashBtn}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <QtyStepper
                    value={row.qty}
                    onChange={(next) =>
                      setRows((rs) =>
                        rs.map((r, i) => (i === idx ? { ...r, qty: next } : r)),
                      )
                    }
                  />
                  {selected?.stock_unit && qtyNum > 0 && (
                    <span className="text-ink-dim text-sm whitespace-nowrap">
                      {pluralize(selected.stock_unit, qtyNum)}
                    </span>
                  )}
                  <div className="ml-auto">{trashBtn}</div>
                </div>
              )}
            </div>
          )
        })}

        <button
          type="button"
          onClick={() => setRows((rs) => [...rs, blankRow()])}
          className={cn(
            "flex items-center justify-center gap-2 text-cyan text-sm py-3 rounded-xl",
            "border border-dashed border-cyan/30 bg-cyan/[0.02]",
            "transition-[background-color,border-color,transform] duration-150 ease-out",
            "hover:bg-cyan/5 hover:border-cyan/50",
            "active:scale-[0.99]",
          )}
        >
          <Plus className="w-4 h-4" /> Add another item
        </button>

        {state.error && <p className="text-coral text-sm">{state.error}</p>}

        <button
          type="submit"
          disabled={!valid || pending}
          className={cn(
            "mt-1 h-12 rounded-lg text-base font-medium",
            "transition-[background,color,border-color,transform,filter] duration-150 ease-out",
            "active:scale-[0.98] active:brightness-95",
            valid && !pending
              ? "bg-gradient-to-b from-cyan to-cyan-deep text-[#061018] shadow-[0_6px_20px_-6px_rgba(56,189,248,0.55)]"
              : "bg-bg-elev border border-line-soft text-ink-mute cursor-not-allowed",
          )}
        >
          {pending ? "Saving…" : "Submit sign-out"}
        </button>
      </form>

      {showToast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 bg-grass/10 border border-grass/30 text-grass text-sm px-4 py-2.5 rounded-lg shadow-card">
          Sign-out saved.
        </div>
      )}
    </div>
  )
}

function QtyStepper({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const num = Number(value) || 0

  const dec = () => {
    const next = Math.max(1, Math.floor(num) - 1)
    onChange(String(next))
  }
  const inc = () => {
    const next = Math.floor(num) + 1
    onChange(String(next))
  }

  return (
    <div
      className={cn(
        "flex-1 min-w-0 flex items-stretch rounded-lg overflow-hidden",
        "bg-[#0E1C2A] border border-line",
        "focus-within:border-cyan focus-within:ring-2 focus-within:ring-cyan/30",
        "transition-[border-color,box-shadow] duration-150 ease-out",
      )}
    >
      <button
        type="button"
        onClick={dec}
        disabled={num <= 1}
        aria-label="Decrease quantity"
        className={cn(
          "flex-1 min-w-0 h-11 grid place-items-center text-ink-dim",
          "hover:text-ink active:bg-white/5 active:scale-[0.95]",
          "transition-[color,background-color,transform] duration-150 ease-out",
          "disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100",
        )}
      >
        <Minus className="w-4 h-4" strokeWidth={2} />
      </button>
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "flex-1 min-w-0 h-11 text-base text-ink text-center",
          "bg-transparent border-x border-line",
          "focus:outline-none",
          "[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          "[appearance:textfield]",
        )}
      />
      <button
        type="button"
        onClick={inc}
        aria-label="Increase quantity"
        className={cn(
          "flex-1 min-w-0 h-11 grid place-items-center text-ink-dim",
          "hover:text-ink active:bg-white/5 active:scale-[0.95]",
          "transition-[color,background-color,transform] duration-150 ease-out",
        )}
      >
        <Plus className="w-4 h-4" strokeWidth={2} />
      </button>
    </div>
  )
}
