"use client"

/**
 * Searchable tech picker — replaces the native <select> wherever a tech is the
 * target of an action. Techs are grouped by their office (the tech's branch),
 * each group collapsible; the search box cuts across every group. Purely
 * presentational: options in, one chosen id out.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Search } from "lucide-react"

export function TechSelect({
  techs,
  officeOf,
  placeholder,
  value = null,
  onSelect,
  direction = "down",
  className = "",
}: {
  techs: { id: string; name: string }[]
  /** techId → office label; null groups under "No office". */
  officeOf: (id: string) => string | null
  placeholder: string
  /** Currently chosen tech id, for controlled usages; null shows the placeholder. */
  value?: string | null
  onSelect: (id: string) => void
  /** Which way the panel opens — "up" for pickers docked to the bottom of the screen. */
  direction?: "down" | "up"
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const byOffice = new Map<string, { id: string; name: string }[]>()
    for (const t of techs) {
      if (needle && !t.name.toLowerCase().includes(needle)) continue
      const office = officeOf(t.id) ?? "No office"
      const g = byOffice.get(office) ?? []
      g.push(t)
      byOffice.set(office, g)
    }
    return [...byOffice.entries()]
      .map(([office, list]) => ({
        office,
        list: list.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) =>
        a.office === "No office" ? 1 : b.office === "No office" ? -1 : a.office.localeCompare(b.office),
      )
  }, [techs, officeOf, query])

  const chosen = value ? techs.find((t) => t.id === value)?.name : null
  const searching = query.trim().length > 0

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded border border-line bg-transparent px-1.5 py-1 text-left text-[10.5px]"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`min-w-0 flex-1 truncate ${chosen ? "text-ink" : "text-ink-mute"}`}>
          {chosen ?? placeholder}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-ink-mute" strokeWidth={2} />
      </button>
      {open && (
        <div
          className={`absolute left-0 z-30 w-56 rounded-lg border border-line-soft bg-[#0b1620]/95 shadow-xl shadow-black/40 backdrop-blur-md ${
            direction === "up" ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          <div className="relative flex items-center border-b border-line-soft">
            <Search className="pointer-events-none absolute left-2 h-3 w-3 text-ink-mute" strokeWidth={2} />
            <input
              autoFocus
              className="w-full bg-transparent py-1.5 pl-6 pr-2 text-[11px] text-ink placeholder:text-ink-mute/60 outline-none"
              placeholder="search techs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false)
              }}
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {groups.map((g) => {
              const folded = !searching && collapsed.has(g.office)
              return (
                <div key={g.office}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 px-2 py-1 text-left text-[9.5px] uppercase tracking-[0.12em] text-ink-mute hover:text-ink-dim"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev)
                        if (next.has(g.office)) next.delete(g.office)
                        else next.add(g.office)
                        return next
                      })
                    }
                  >
                    {folded ? (
                      <ChevronRight className="h-2.5 w-2.5" strokeWidth={2.5} />
                    ) : (
                      <ChevronDown className="h-2.5 w-2.5" strokeWidth={2.5} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{g.office}</span>
                    <span className="font-mono num">{g.list.length}</span>
                  </button>
                  {!folded &&
                    g.list.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`block w-full truncate px-3 py-1 text-left text-[11px] ${
                          t.id === value ? "bg-cyan/10 text-cyan" : "text-ink-dim hover:bg-white/[0.05] hover:text-ink"
                        }`}
                        onClick={() => {
                          onSelect(t.id)
                          setOpen(false)
                          setQuery("")
                        }}
                      >
                        {t.name}
                      </button>
                    ))}
                </div>
              )
            })}
            {groups.length === 0 && (
              <p className="px-3 py-2 text-[11px] text-ink-mute">no techs match</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
