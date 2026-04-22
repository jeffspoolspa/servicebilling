"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils/cn"
import type { SignOutItem } from "@/lib/entities/inventory-signout/types"
import {
  SIGNOUT_CATEGORIES,
  SIGNOUT_CATEGORY_LABELS,
} from "@/lib/entities/inventory-signout/signout-items"

interface Props {
  items: SignOutItem[]
  storageKey: string
}

export function TruckCheckList({ items, storageKey }: Props) {
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [hydrated, setHydrated] = useState(false)

  // Hydrate from localStorage on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          setChecked(new Set(parsed.filter((n): n is number => typeof n === "number")))
        }
      }
    } catch {
      // ignore
    }
    setHydrated(true)
  }, [storageKey])

  // Persist on change.
  useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(Array.from(checked)))
    } catch {
      // ignore
    }
  }, [checked, hydrated, storageKey])

  const toggle = useCallback((id: number) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const reset = useCallback(() => setChecked(new Set()), [])

  const missing = useMemo(() => items.filter((it) => !checked.has(it.id)), [items, checked])
  const missingCount = missing.length
  const hasMissing = missingCount > 0

  const goToPickList = useCallback(() => {
    if (!hasMissing) return
    const ids = missing.map((i) => i.id).join(",")
    window.location.href = `/sign-out?prefill=${ids}`
  }, [hasMissing, missing])

  if (items.length === 0) {
    return (
      <div className="text-coral text-sm border border-coral/20 bg-coral/5 rounded-lg p-3.5">
        No items are currently enabled. Ask an admin to update the allowlist.
      </div>
    )
  }

  let runningIndex = 0

  return (
    <div className="flex flex-col gap-6 pb-28">
      <div className="flex items-center justify-between">
        <div className="text-sm text-ink-dim">
          Tap each item you already have on your truck.
        </div>
        {checked.size > 0 && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-ink-mute hover:text-ink transition-colors duration-150 underline underline-offset-2"
          >
            Reset
          </button>
        )}
      </div>

      {SIGNOUT_CATEGORIES.map((cat) => {
        const group = items.filter((it) => it.category === cat)
        if (group.length === 0) return null
        return (
          <section key={cat}>
            <h2 className="text-ink-mute text-[11px] font-semibold tracking-[0.16em] uppercase mb-2 px-1">
              {SIGNOUT_CATEGORY_LABELS[cat]}
            </h2>
            <div className="flex flex-col gap-2">
              {group.map((item) => {
                const idx = runningIndex++
                return (
                  <ChecklistCard
                    key={item.id}
                    item={item}
                    checked={checked.has(item.id)}
                    onToggle={() => toggle(item.id)}
                    index={idx}
                    hydrated={hydrated}
                  />
                )
              })}
            </div>
          </section>
        )
      })}

      <StickyFooter
        missingCount={missingCount}
        visible={hasMissing}
        onClick={goToPickList}
      />
    </div>
  )
}

function ChecklistCard({
  item,
  checked,
  onToggle,
  index,
  hydrated,
}: {
  item: SignOutItem
  checked: boolean
  onToggle: () => void
  index: number
  hydrated: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={checked}
      className={cn(
        "truck-card-enter flex items-center gap-3 w-full min-h-[56px] px-4 rounded-xl text-left",
        "border transition-[background-color,border-color,transform,box-shadow] duration-[180ms] ease-[cubic-bezier(0.215,0.61,0.355,1)]",
        "active:scale-[0.97]",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/50",
        checked
          ? "bg-cyan/5 border-cyan/40 shadow-[0_0_0_1px_rgba(56,189,248,0.18)]"
          : "bg-bg-elev/50 border-line-soft hover:border-line",
      )}
      style={{ animationDelay: hydrated ? "0ms" : `${Math.min(index * 30, 600)}ms` }}
    >
      <CheckCircle checked={checked} />
      <span
        className={cn(
          "flex-1 text-base transition-colors duration-150",
          checked ? "text-ink" : "text-ink-dim",
        )}
      >
        {item.display_name}
      </span>
    </button>
  )
}

function CheckCircle({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0",
        "transition-[background-color,border-color] duration-[180ms] ease-[cubic-bezier(0.215,0.61,0.355,1)]",
        checked ? "bg-cyan border-cyan" : "bg-transparent border-ink-mute",
      )}
    >
      {checked && (
        <svg
          viewBox="0 0 16 16"
          className="w-3.5 h-3.5 text-[#061018]"
          fill="none"
          aria-hidden
        >
          <path
            d="M3.5 8.5l2.8 2.8 6.2-6.6"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="check-draw"
          />
        </svg>
      )}
    </span>
  )
}

function StickyFooter({
  missingCount,
  visible,
  onClick,
}: {
  missingCount: number
  visible: boolean
  onClick: () => void
}) {
  return (
    <div
      className={cn(
        "fixed bottom-0 left-0 right-0 z-20 pointer-events-none",
        "transition-transform duration-[220ms] ease-[cubic-bezier(0.165,0.84,0.44,1)]",
        visible ? "translate-y-0" : "translate-y-full",
      )}
    >
      <div className="pointer-events-auto bg-bg/90 backdrop-blur-md border-t border-line-soft">
        <div className="max-w-md mx-auto px-5 py-3 flex items-center gap-3">
          <div className="text-sm text-ink-dim flex items-center gap-1.5">
            <span className="text-ink font-medium num">
              <span key={missingCount} className="tick-bump inline-block">
                {missingCount}
              </span>
            </span>
            {missingCount === 1 ? "item" : "items"} missing
          </div>
          <button
            type="button"
            onClick={onClick}
            disabled={!visible}
            className={cn(
              "ml-auto h-11 px-5 rounded-lg font-medium text-[#061018] text-sm",
              "bg-gradient-to-b from-cyan to-cyan-deep",
              "transition-all duration-150 ease-out",
              "active:scale-[0.97] active:brightness-95",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            Create pick list
          </button>
        </div>
      </div>
    </div>
  )
}
