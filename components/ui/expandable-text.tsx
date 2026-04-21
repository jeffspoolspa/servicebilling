"use client"

import { useState, useRef, useLayoutEffect } from "react"
import { cn } from "@/lib/utils/cn"

/**
 * Clamped (aka "line-clamped" / "truncated with show-more") text block.
 *
 * The CSS technical term is **line-clamping** — capping a block to N lines
 * with `-webkit-line-clamp` and revealing the overflow via a toggle. When the
 * content fits within the limit, no toggle is shown.
 *
 * Usage:
 *   <ExpandableText lines={6}>
 *     {longDescription}
 *   </ExpandableText>
 */
interface ExpandableTextProps {
  children: string
  lines?: number // default 6
  className?: string
}

export function ExpandableText({ children, lines = 6, className }: ExpandableTextProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setOverflowing(el.scrollHeight - el.clientHeight > 1)
  }, [children, lines])

  const clampStyle = !expanded
    ? {
        display: "-webkit-box",
        WebkitLineClamp: String(lines),
        WebkitBoxOrient: "vertical" as const,
        overflow: "hidden",
      }
    : undefined

  return (
    <div>
      <div
        ref={ref}
        className={cn("whitespace-pre-wrap", className)}
        style={clampStyle}
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1.5 text-[11px] text-cyan hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  )
}
