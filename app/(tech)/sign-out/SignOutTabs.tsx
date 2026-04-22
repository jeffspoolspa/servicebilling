"use client"

import { useState, type ReactNode } from "react"
import { cn } from "@/lib/utils/cn"

type SubTab = "new" | "today"

interface Props {
  todayCount: number
  newPane: ReactNode
  todayPane: ReactNode
}

export function SignOutTabs({ todayCount, newPane, todayPane }: Props) {
  const [active, setActive] = useState<SubTab>("new")

  return (
    <div className="flex flex-col gap-5">
      <div
        role="tablist"
        aria-label="Sign-out sections"
        className="grid grid-cols-2 p-1 rounded-xl bg-bg-elev/60 border border-line-soft"
      >
        <TabBtn active={active === "new"} onClick={() => setActive("new")} label="New" />
        <TabBtn
          active={active === "today"}
          onClick={() => setActive("today")}
          label="Today"
          count={todayCount}
        />
      </div>

      {active === "new" ? newPane : todayPane}
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "h-10 rounded-lg text-sm font-medium",
        "transition-[background-color,color,box-shadow] duration-150 ease-out",
        "active:scale-[0.98]",
        active
          ? "bg-[#0E1C2A] text-ink shadow-[0_1px_0_0_rgba(56,189,248,0.25)_inset]"
          : "text-ink-dim hover:text-ink",
      )}
    >
      {label}
      {count != null && (
        <span
          className={cn(
            "ml-1.5 num text-xs",
            active ? "text-cyan" : "text-ink-mute",
          )}
        >
          <span key={count} className="tick-bump inline-block">
            {count}
          </span>
        </span>
      )}
    </button>
  )
}
