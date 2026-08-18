"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils/cn"

/** What a wheel needs to render — readings and pool volume both satisfy it. */
export interface WheelSpec {
  label: string
  unit: string
  min: number
  max: number
  step: number
  start: number
}

const ROW = 44 // px per wheel row
const VISIBLE = 5 // odd, so one row centres

function fmt(v: number, step: number) {
  return step < 1 ? v.toFixed(1) : v.toLocaleString()
}

/**
 * Bottom-sheet wheel picker for one reading — the iOS date-picker pattern:
 * scroll-snap rows, the centred row is the value. No keyboard, so it works
 * with wet hands, and "Not measured" is an explicit choice rather than an
 * empty text box.
 */
export function ReadingWheelSheet({
  field,
  value,
  onDone,
  onClear,
  onClose,
  clearLabel = "Not measured",
}: {
  field: WheelSpec
  value: number | undefined
  onDone: (v: number) => void
  onClear: () => void
  onClose: () => void
  clearLabel?: string
}) {
  const [closing, setClosing] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)

  const values = useMemo(() => {
    const out: number[] = []
    // Float steps drift (0.1 * 3 !== 0.3), so build from integer counts.
    const n = Math.round((field.max - field.min) / field.step)
    for (let i = 0; i <= n; i++) out.push(Number((field.min + i * field.step).toFixed(2)))
    return out
  }, [field])

  // Open centred on the current value, or a typical in-band start.
  useEffect(() => {
    const target = value ?? field.start
    const i = values.reduce(
      (best, v, j) => (Math.abs(v - target) < Math.abs(values[best] - target) ? j : best),
      0,
    )
    setIndex(i)
    listRef.current?.scrollTo({ top: i * ROW })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lock body scroll while open.
  useEffect(() => {
    const original = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = original
    }
  }, [])

  const dismiss = (after?: () => void) => {
    if (closing) return
    setClosing(true)
    setTimeout(() => {
      onClose()
      after?.()
    }, 180)
  }

  const onScroll = () => {
    const el = listRef.current
    if (el) setIndex(Math.max(0, Math.min(values.length - 1, Math.round(el.scrollTop / ROW))))
  }

  const pad = ((VISIBLE - 1) / 2) * ROW

  return (
    <div role="dialog" aria-modal="true" aria-label={`Set ${field.label}`} className="fixed inset-0 z-40">
      <div
        onClick={() => dismiss()}
        className={cn(
          "absolute inset-0 bg-black/50 backdrop-blur-[2px]",
          "transition-opacity duration-200 ease-out",
          closing ? "opacity-0" : "opacity-100 animate-[fade-in_180ms_ease-out_both]",
        )}
      />

      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 pb-[env(safe-area-inset-bottom)]",
          "bg-bg-elev border-t border-line rounded-t-2xl shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.5)]",
          "transition-transform ease-[cubic-bezier(0.165,0.84,0.44,1)]",
          closing
            ? "translate-y-full duration-[180ms]"
            : "translate-y-0 duration-[260ms] animate-[sheet-slide-up_260ms_cubic-bezier(0.165,0.84,0.44,1)_both]",
        )}
      >
        <div className="w-10 h-1.5 rounded-full bg-line-soft mx-auto mt-2" />
        <div className="flex items-baseline justify-between px-5 pt-3">
          <h2 className="font-display text-base">
            {field.label}
            {field.unit && <span className="text-ink-mute text-sm font-normal"> {field.unit}</span>}
          </h2>
          <button
            type="button"
            onClick={() => dismiss(onClear)}
            className="text-sm text-ink-dim min-h-11 px-2 active:text-ink"
          >
            {clearLabel}
          </button>
        </div>

        {/* The wheel */}
        <div className="relative mx-5 my-2" style={{ height: ROW * VISIBLE }}>
          {/* Centre-row highlight */}
          <div
            className="absolute inset-x-0 rounded-lg bg-cyan/10 pointer-events-none"
            style={{ top: pad, height: ROW }}
          />
          {/* Fade masks */}
          <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-bg-elev to-transparent pointer-events-none z-10" />
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-bg-elev to-transparent pointer-events-none z-10" />
          <div
            ref={listRef}
            onScroll={onScroll}
            className="h-full overflow-y-auto overscroll-contain snap-y snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div style={{ height: pad }} />
            {values.map((v, i) => (
              <button
                key={v}
                type="button"
                onClick={() => listRef.current?.scrollTo({ top: i * ROW, behavior: "smooth" })}
                className={cn(
                  "w-full snap-center grid place-items-center text-center tabular-nums",
                  "transition-[color,transform] duration-100",
                  i === index ? "text-ink text-2xl font-medium" : "text-ink-mute text-lg",
                )}
                style={{ height: ROW }}
              >
                {fmt(v, field.step)}
              </button>
            ))}
            <div style={{ height: pad }} />
          </div>
        </div>

        <div className="px-5 pb-5 pt-1">
          <button
            type="button"
            onClick={() => dismiss(() => onDone(values[index]))}
            className={cn(
              "w-full h-12 rounded-full text-base font-medium",
              "bg-gradient-to-b from-cyan to-cyan-deep text-[#061018]",
              "active:scale-[0.98] transition-transform duration-150",
            )}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
