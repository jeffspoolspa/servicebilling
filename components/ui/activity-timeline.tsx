"use client"

import { useMemo, useState } from "react"
import { cn } from "@/lib/utils/cn"

/**
 * Reusable, presentational activity timeline. Knows nothing about leads — feed it
 * a normalized list of TimelineItem + a `types` config and it renders the card:
 * a count badge, a TYPE filter, day-grouped rows (TODAY / YESTERDAY / "Apr 24"),
 * each with a dot colored BY EVENT TYPE, a bold title, a gray description, an
 * optional red/green status word, and the relative time.
 *
 * Two independent dimensions:
 *   - type   → the dot color + the filter buckets (what KIND of event it is)
 *   - status → a small green/red word on the right (the OUTCOME: delivered/failed)
 *
 * Source-agnostic: a lead timeline, a customer feed, a work-order history all map
 * their rows to TimelineItem and reuse this with their own `types` map.
 */

export type TimelineColor = "cyan" | "teal" | "sun" | "coral" | "grass" | "indigo" | "neutral"

export interface TimelineType {
  /** Shown in the filter dropdown. */
  label: string
  /** The dot color for this event type. */
  color: TimelineColor
}

/** A label/value pair shown in a row's expanded detail panel. */
export interface TimelineDetail {
  label: string
  value: string
}

export interface TimelineItem {
  id: string
  /** ISO timestamp — drives day grouping + the relative time on the right. */
  at: string
  /** Key into the `types` map → dot color + filter bucket. */
  type: string
  /** Bold lead text, e.g. "Quote emailed" or "Accepted". */
  title: string
  /** Gray subtitle, e.g. the note body or "over the phone, completed by Sarah". */
  description?: string
  /** Optional outcome word on the right (sends, etc.). Lifecycle events omit it. */
  status?: { label: string; tone: "good" | "bad" | "neutral" }
  /** When present, the row is clickable and expands to show these details
   *  (e.g. To: …, Subject: …, delivery timeline). */
  details?: TimelineDetail[]
}

const dotColor: Record<TimelineColor, string> = {
  cyan: "bg-cyan",
  teal: "bg-teal",
  sun: "bg-sun",
  coral: "bg-coral",
  grass: "bg-grass",
  indigo: "bg-indigo-400",
  neutral: "bg-ink-mute",
}
const statusTone: Record<"good" | "bad" | "neutral", string> = {
  good: "text-grass",
  bad: "text-coral",
  neutral: "text-ink-mute",
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
function monthDay(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) // "Apr 24"
}
function relativeTime(at: Date, now: Date): string {
  const dayDiff = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (dayDiff === 0) {
    const min = Math.floor((now.getTime() - at.getTime()) / 60_000)
    if (min < 1) return "now"
    if (min < 60) return `${min}m`
    return `${Math.floor(min / 60)}h`
  }
  if (dayDiff === 1) return "yesterday"
  return monthDay(at)
}
function dayGroupLabel(at: Date, now: Date): string {
  const dayDiff = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (dayDiff === 0) return "TODAY"
  if (dayDiff === 1) return "YESTERDAY"
  return monthDay(at).toUpperCase()
}

interface ActivityTimelineProps {
  items: TimelineItem[]
  /** type key → { label, color }. Drives dot colors + the filter options. */
  types: Record<string, TimelineType>
  title?: string
  /** Show the type filter dropdown (default true). */
  filterable?: boolean
  className?: string
}

export function ActivityTimeline({
  items,
  types,
  title = "Activity",
  filterable = true,
  className,
}: ActivityTimelineProps) {
  const now = useMemo(() => new Date(), [])
  const [filter, setFilter] = useState<string>("All") // "All" or a type key
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Filter buckets = the types actually present, in first-seen order.
  const presentTypes = useMemo(() => {
    const seen: string[] = []
    for (const i of items) if (types[i.type] && !seen.includes(i.type)) seen.push(i.type)
    return seen
  }, [items, types])

  const filtered = filter === "All" ? items : items.filter((i) => i.type === filter)

  const groups = useMemo(() => {
    const out: { label: string; rows: TimelineItem[] }[] = []
    for (const item of filtered) {
      const label = dayGroupLabel(new Date(item.at), now)
      const last = out[out.length - 1]
      if (last && last.label === label) last.rows.push(item)
      else out.push({ label, rows: [item] })
    }
    return out
  }, [filtered, now])

  const filterLabel = filter === "All" ? "All" : types[filter]?.label ?? "All"

  return (
    <div className={cn("rounded-lg border border-line bg-surface shadow-card", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-line-soft">
        <div className="flex items-center gap-2">
          <h3 className="text-ink font-semibold text-[15px]">{title}</h3>
          <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-white/5 border border-line text-ink-mute text-[11px] font-medium">
            {filtered.length}
          </span>
        </div>
        {filterable && presentTypes.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              onBlur={() => setTimeout(() => setOpen(false), 120)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-bg-elev px-3 py-1.5 text-[13px] text-ink-dim hover:text-ink transition-colors"
            >
              {filterLabel}
              <span className="text-ink-mute text-[10px]">▾</span>
            </button>
            {open && (
              <div className="absolute right-0 mt-1 z-10 min-w-[150px] rounded-lg border border-line bg-bg-elev shadow-card py-1">
                {["All", ...presentTypes].map((key) => {
                  const label = key === "All" ? "All" : types[key]?.label ?? key
                  const color = key === "All" ? null : types[key]?.color ?? "neutral"
                  return (
                    <button
                      key={key}
                      type="button"
                      onMouseDown={() => {
                        setFilter(key)
                        setOpen(false)
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-white/5 transition-colors",
                        key === filter ? "text-ink" : "text-ink-dim",
                      )}
                    >
                      {color && <span className={cn("h-2 w-2 rounded-full", dotColor[color])} />}
                      {label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Rows */}
      <div className="px-5 pb-2">
        {groups.length === 0 && (
          <div className="py-8 text-center text-ink-mute text-sm">No activity yet.</div>
        )}
        {groups.map((group) => (
          <div key={group.label}>
            <div className="pt-4 pb-1 text-[11px] font-semibold tracking-[0.08em] text-ink-mute/70 uppercase">
              {group.label}
            </div>
            {group.rows.map((item) => {
              const color = types[item.type]?.color ?? "neutral"
              const hasDetails = !!item.details?.length
              const isOpen = expanded.has(item.id)
              return (
                <div key={item.id} className="border-b border-dashed border-line-soft last:border-0">
                  <div
                    className={cn(
                      "flex w-full gap-3 py-3",
                      hasDetails && "cursor-pointer rounded-md hover:bg-white/[0.02] transition-colors",
                    )}
                    role={hasDetails ? "button" : undefined}
                    tabIndex={hasDetails ? 0 : undefined}
                    aria-expanded={hasDetails ? isOpen : undefined}
                    onClick={hasDetails ? () => toggle(item.id) : undefined}
                    onKeyDown={
                      hasDetails
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              toggle(item.id)
                            }
                          }
                        : undefined
                    }
                  >
                    <span className={cn("h-2 w-2 rounded-full mt-[5px] shrink-0", dotColor[color])} />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-semibold text-ink truncate">{item.title}</span>
                        <span className="flex items-baseline gap-2 shrink-0 text-xs">
                          {item.status && (
                            <span className={cn("font-medium", statusTone[item.status.tone])}>
                              {item.status.label}
                            </span>
                          )}
                          <span className="text-ink-mute">{relativeTime(new Date(item.at), now)}</span>
                          {hasDetails && (
                            <span
                              className={cn(
                                "text-ink-mute text-[10px] transition-transform",
                                isOpen && "rotate-90",
                              )}
                            >
                              ▸
                            </span>
                          )}
                        </span>
                      </div>
                      {item.description && (
                        <div className={cn("mt-0.5 text-[13px] text-ink-mute", !isOpen && "truncate")}>
                          {item.description}
                        </div>
                      )}
                    </div>
                  </div>

                  {hasDetails && isOpen && (
                    <div className="pl-5 pb-3 -mt-0.5">
                      <div className="rounded-lg border border-line-soft bg-bg-elev/60 px-3 py-2 flex flex-col gap-1.5">
                        {item.details!.map((d, i) => (
                          <div key={i} className="flex justify-between gap-4 text-xs">
                            <span className="text-ink-mute shrink-0">{d.label}</span>
                            <span className="text-ink-dim text-right break-words min-w-0">{d.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
