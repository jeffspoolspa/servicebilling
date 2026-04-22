"use client"

import { useState, useTransition } from "react"
import { Trash2, Minus, Plus } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { TodaysSignOut } from "@/lib/entities/inventory-signout/today"
import { updateTodaySignOut, deleteTodaySignOut } from "./today-actions"

interface Props {
  rows: TodaysSignOut[]
}

function pluralize(word: string, n: number) {
  if (n === 1) return word
  if (word.endsWith("y")) return word.slice(0, -1) + "ies"
  return word + "s"
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
}

export function TodayList({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-ink-dim border border-line-soft bg-bg-elev/40 rounded-xl px-4 py-6 text-center">
        No sign-outs yet today. Submitting one on the{" "}
        <span className="text-ink">New</span> tab will list it here.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <TodayRow key={row.id} row={row} />
      ))}
    </div>
  )
}

function TodayRow({ row }: { row: TodaysSignOut }) {
  const bulk = row.multiplier > 1 && row.input_unit !== null
  const [qty, setQty] = useState<number>(row.quantity)
  const [saving, startSaving] = useTransition()
  const [deleting, startDeleting] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const dirty = qty !== row.quantity
  const display = bulk && row.input_unit
    ? `${row.quantity / row.multiplier} ${pluralize(row.input_unit, row.quantity / row.multiplier)}`
    : null

  const commitUpdate = (next: number) => {
    if (next <= 0) return
    setError(null)
    setQty(next)
    startSaving(async () => {
      const fd = new FormData()
      fd.set("id", String(row.id))
      fd.set("quantity", String(next))
      const res = await updateTodaySignOut({}, fd)
      if (res.error) {
        setError(res.error)
        setQty(row.quantity)
      }
    })
  }

  const commitDelete = () => {
    setError(null)
    startDeleting(async () => {
      const fd = new FormData()
      fd.set("id", String(row.id))
      const res = await deleteTodaySignOut({}, fd)
      if (res.error) setError(res.error)
    })
  }

  return (
    <div
      className={cn(
        "rounded-xl p-3 bg-bg-elev/60 border border-line-soft flex flex-col gap-2",
        deleting && "opacity-50",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-ink font-medium truncate">{row.display_name}</div>
        <div className="text-ink-mute text-xs whitespace-nowrap">{formatTime(row.signed_out_at)}</div>
      </div>

      {bulk ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink">{display}</span>
          <span className="text-ink-mute">
            {row.quantity} {row.stock_unit && pluralize(row.stock_unit, row.quantity)}
          </span>
          <TrashBtn onClick={commitDelete} disabled={deleting} />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <QtyStepper
            value={qty}
            onDec={() => commitUpdate(Math.max(1, Math.floor(qty) - 1))}
            onInc={() => commitUpdate(Math.floor(qty) + 1)}
            onInput={(v) => setQty(v)}
            onBlur={() => {
              if (dirty && qty > 0) commitUpdate(qty)
            }}
            disabled={saving || deleting}
          />
          {row.stock_unit && qty > 0 && (
            <span className="text-ink-dim text-sm whitespace-nowrap">
              {pluralize(row.stock_unit, qty)}
            </span>
          )}
          <div className="ml-auto">
            <TrashBtn onClick={commitDelete} disabled={deleting} />
          </div>
        </div>
      )}

      {error && <p className="text-coral text-xs">{error}</p>}
    </div>
  )
}

function TrashBtn({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Delete sign-out"
      className={cn(
        "shrink-0 w-11 h-11 grid place-items-center rounded-lg",
        "text-ink-mute hover:text-coral hover:bg-coral/10",
        "transition-[color,background-color,transform] duration-150 ease-out",
        "active:scale-[0.92]",
        "disabled:opacity-40 disabled:cursor-not-allowed",
      )}
    >
      <Trash2 className="w-4 h-4" strokeWidth={1.8} />
    </button>
  )
}

function QtyStepper({
  value,
  onDec,
  onInc,
  onInput,
  onBlur,
  disabled,
}: {
  value: number
  onDec: () => void
  onInc: () => void
  onInput: (v: number) => void
  onBlur: () => void
  disabled: boolean
}) {
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
        onClick={onDec}
        disabled={disabled || value <= 1}
        aria-label="Decrease"
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
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onInput(Number(e.target.value))}
        onBlur={onBlur}
        disabled={disabled}
        className={cn(
          "flex-1 min-w-0 h-11 text-base text-ink text-center",
          "bg-transparent border-x border-line",
          "focus:outline-none",
          "[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
          "[appearance:textfield]",
          "disabled:opacity-60",
        )}
      />
      <button
        type="button"
        onClick={onInc}
        disabled={disabled}
        aria-label="Increase"
        className={cn(
          "flex-1 min-w-0 h-11 grid place-items-center text-ink-dim",
          "hover:text-ink active:bg-white/5 active:scale-[0.95]",
          "transition-[color,background-color,transform] duration-150 ease-out",
          "disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100",
        )}
      >
        <Plus className="w-4 h-4" strokeWidth={2} />
      </button>
    </div>
  )
}
