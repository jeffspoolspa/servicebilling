"use client"

import { useMemo, useState } from "react"
import { cn } from "@/lib/utils/cn"
import { formatCurrency } from "@/lib/utils/format"
import { RoutePlannerMap, type PlannerMapStop } from "./route-planner-map"

// Full day names, index 0=Sun..6=Sat — mirrors DAY_NAMES in _lib/views. Inlined
// here (not imported) because views.ts pulls in server-only supabase code that
// must not leak into this "use client" bundle.
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const

/**
 * Route Planner — the maintenance routes index. One page, two views (Matrix /
 * Map) sharing ONE chrome layout so nothing jumps when you tab between them:
 *
 *   ┌─ Top bar (full width, identical on both) ──────────────────────────────┐
 *   │  [Matrix│Map]  [Office ▾]  · day filters (map) / blank, reserved (matrix)│
 *   ├───────────────┬─────────────────────────────────────────────────────────┤
 *   │  Side card    │  Matrix grid  (or)  Map panel                            │
 *   │  (same place) │                                                          │
 *   └───────────────┴─────────────────────────────────────────────────────────┘
 *
 * The toggle + office picker sit at the SAME spot in the bar on both views; the
 * side card occupies the SAME box on both. Only the right region of the bar and
 * the main area differ. All data is real (stop_count / customers / addresses /
 * sequence / frequency / revenue from v_routes_summary + v_route_stops). No
 * drive-time / route-estimate / fake tags — we don't track those.
 */

// Opaque card surface used for every panel + the top bar.
const SOLID = "bg-bg-elev border border-line shadow-card"

// ── Serializable row shapes passed from the server page ──────────────────────

/** One merged (tech, day) route — the matrix cell + detail header source. */
export interface PlannerRoute {
  key: string // `${techId}|${day}`
  techId: string
  techName: string | null
  office: string | null
  day: number
  /** the tech's color (pin/dot fill) */
  color: string
  stopCount: number
  totalPriceCents: number
  weeklyCount: number
  biweeklyCount: number
  monthlyCount: number
}

/** One stop on a route — the detail stop-list + map-pin source. */
export interface PlannerStop {
  key: string // routeKey `${techId}|${day}`
  techId: string
  day: number
  scheduleId: string
  customerId: number | null
  customerName: string | null
  street: string | null
  city: string | null
  sequence: number | null
  lat: number | null
  lng: number | null
  geoTrusted: boolean
  color: string
}

export interface PlannerTech {
  id: string
  name: string | null
  office: string | null
  color: string
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

// Two-letter day glyph shown in the CENTER of a map pin (index 0=Sun..6=Sat).
// Day is encoded by this readable glyph rather than color, so it stays legible on
// the dark map and needs no legend — tech is the pin color, day is the letters.
const DAY_GLYPH = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const

// Every pin gets a solid black outline (crisp definition on any tech fill). Day
// is told apart by hover-scaling from the legend, not by border color.
const PIN_BORDER = "#000000"

/** Black or white, whichever reads on top of `hex` (sRGB luminance). Used for
 *  the day glyph sitting on a tech-colored pin/dot. */
export function glyphColor(hex: string): string {
  if (!hex) return "#ffffff"
  const h = hex.replace("#", "")
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? "#0b1620" : "#ffffff"
}

/** Compact route indicator for the list: tech-colored disc with the day glyph. */
function TechDayDot({ techColor, day, size = 18 }: { techColor: string; day: number; size?: number }) {
  return (
    <span
      className="rounded-full flex-shrink-0 grid place-items-center font-mono font-bold leading-none"
      style={{ width: size, height: size, background: techColor, color: glyphColor(techColor), fontSize: size * 0.5 }}
      title={DAY_NAMES[day]}
    >
      {DAY_GLYPH[day]}
    </span>
  )
}

export function RoutePlanner({
  token,
  routes,
  stops,
  techs,
  offices,
}: {
  token: string | null
  routes: PlannerRoute[]
  stops: PlannerStop[]
  techs: PlannerTech[]
  /** Real offices present in the data, in HOME_OFFICES order. */
  offices: string[]
}) {
  const [view, setView] = useState<"matrix" | "map">("matrix")
  const [office, setOffice] = useState<string | null>(null)
  const [days, setDays] = useState<Record<number, boolean>>({})
  const [techFilter, setTechFilter] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [officeOpen, setOfficeOpen] = useState(false)
  // Days hidden from the map via the legend checkboxes — a VISIBILITY layer that's
  // separate from the day filter (`days`), so you can hide a day from view and
  // check it back. The day filter controls which days the legend lists.
  const [dayHidden, setDayHidden] = useState<Record<number, boolean>>({})
  // Day whose pins are scaled up right now (hovering its legend row).
  const [hoverDay, setHoverDay] = useState<number | null>(null)

  const routeByKey = useMemo(() => {
    const m = new Map<string, PlannerRoute>()
    for (const r of routes) m.set(r.key, r)
    return m
  }, [routes])

  const stopsByKey = useMemo(() => {
    const m = new Map<string, PlannerStop[]>()
    for (const s of stops) {
      const arr = m.get(s.key) ?? []
      arr.push(s)
      m.set(s.key, arr)
    }
    return m
  }, [stops])

  // Techs visible given the office filter (a tech belongs to one branch).
  const visibleTechs = useMemo(
    () => (office ? techs.filter((t) => t.office === office) : techs),
    [techs, office],
  )

  const anyDay = ALL_DAYS.some((d) => days[d])
  const anyTech = visibleTechs.some((t) => techFilter[t.id])
  const anyOffice = office != null
  const anyFilter = anyDay || anyTech || anyOffice
  // The day legend (per-day visibility + hover-to-pop) appears while comparing 2+
  // days in the filter; hiding a day from view doesn't drop it from the filter.
  const comparingDays = ALL_DAYS.filter((d) => days[d]).length >= 2

  // Routes that pass office + day + tech filters.
  const visibleTechIds = useMemo(() => new Set(visibleTechs.map((t) => t.id)), [visibleTechs])
  const filteredRoutes = useMemo(
    () =>
      routes.filter(
        (r) =>
          visibleTechIds.has(r.techId) &&
          (!anyDay || days[r.day]) &&
          (!anyTech || techFilter[r.techId]),
      ),
    [routes, visibleTechIds, anyDay, days, anyTech, techFilter],
  )
  const filteredKeys = useMemo(() => new Set(filteredRoutes.map((r) => r.key)), [filteredRoutes])

  // Per-day stop counts for the matrix column headers (respect the office filter).
  const dayCounts = useMemo(() => {
    const c: Record<number, number> = {}
    for (const r of routes) {
      if (!visibleTechIds.has(r.techId)) continue
      c[r.day] = (c[r.day] ?? 0) + r.stopCount
    }
    return c
  }, [routes, visibleTechIds])

  const selectedRoute = selected ? routeByKey.get(selected) ?? null : null
  const selectedStops = useMemo(() => {
    if (!selected) return []
    const arr = [...(stopsByKey.get(selected) ?? [])]
    arr.sort((a, b) => {
      // sequence asc, nulls last
      if (a.sequence == null && b.sequence == null) return 0
      if (a.sequence == null) return 1
      if (b.sequence == null) return -1
      return a.sequence - b.sequence
    })
    return arr
  }, [selected, stopsByKey])

  // Map pins for every stop on a visible route (real geo_trusted coords only).
  // Days hidden via the legend checkboxes are dropped here.
  const mapStops: PlannerMapStop[] = useMemo(() => {
    const out: PlannerMapStop[] = []
    for (const s of stops) {
      if (!filteredKeys.has(s.key)) continue
      if (dayHidden[s.day]) continue
      if (!s.geoTrusted || s.lat == null || s.lng == null) continue
      out.push({
        routeKey: s.key,
        lat: s.lat,
        lng: s.lng,
        color: s.color,
        glyph: DAY_GLYPH[s.day],
        glyphColor: glyphColor(s.color),
        stroke: PIN_BORDER,
        label: s.customerName ?? "(unknown)",
        sub: [s.street, s.city].filter(Boolean).join(", ") || null,
      })
    }
    return out
  }, [stops, filteredKeys, dayHidden])

  // Route keys of the hovered day's pins — the map scales these up so they pop
  // out of a cluster. Only set while hovering a legend row.
  const hoverKeys = useMemo(() => {
    if (hoverDay == null) return null
    const set = new Set<string>()
    for (const r of filteredRoutes) if (r.day === hoverDay) set.add(r.key)
    return set
  }, [hoverDay, filteredRoutes])

  // The selected route's nav line: its stops in visit order (geo_trusted only),
  // as [lng,lat]. The map animates a line drawn through them.
  const routeLine = useMemo<[number, number][] | null>(() => {
    if (!selected) return null
    const pts = selectedStops
      .filter((s) => s.geoTrusted && s.lat != null && s.lng != null)
      .map((s) => [s.lng as number, s.lat as number] as [number, number])
    return pts.length >= 2 ? pts : null
  }, [selected, selectedStops])
  const routeLineColor = selectedRoute?.color ?? null

  function toggleDay(d: number) {
    setDays((s) => ({ ...s, [d]: !s[d] }))
    // adding/removing a day from the filter resets its legend visibility
    setDayHidden((h) => (h[d] ? { ...h, [d]: false } : h))
  }
  function toggleDayHidden(d: number) {
    setDayHidden((h) => ({ ...h, [d]: !h[d] }))
  }
  function toggleTech(id: string) {
    setTechFilter((s) => ({ ...s, [id]: !s[id] }))
  }
  function pickOffice(o: string | null) {
    setOffice(o)
    setTechFilter({})
    setOfficeOpen(false)
    setSelected(null)
  }
  function clearAll() {
    setDays({})
    setTechFilter({})
    setOffice(null)
    setOfficeOpen(false)
    setDayHidden({})
  }
  function selectRoute(key: string) {
    setSelected((cur) => (cur === key ? null : key))
  }

  const totalStops = filteredRoutes.reduce((s, r) => s + r.stopCount, 0)

  // The side card holds the route detail (both views) or, on the map with
  // nothing selected, the route list. Same box, same place on both views.
  const sideCard =
    view === "map" && !selected ? (
      <RouteListPanel
        routes={filteredRoutes}
        totalStops={totalStops}
        selected={selected}
        onSelect={selectRoute}
      />
    ) : (
      <DetailPanel route={selectedRoute} stops={selectedStops} onClose={() => setSelected(null)} />
    )

  return (
    <div
      className="px-7 pt-4 pb-6 flex flex-col gap-3"
      style={{ height: "calc(100vh - 92px)", minHeight: 560 }}
    >
      {/* ===== FULL-WIDTH TOP BAR — identical position of toggle + office on both ===== */}
      <div className={cn(SOLID, "rounded-lg flex flex-wrap items-center gap-3 px-3 py-2 flex-shrink-0")}>
        <ViewToggle view={view} setView={setView} />
        <div className="w-px h-6 bg-line" />
        <OfficePicker
          office={office}
          offices={offices}
          officeOpen={officeOpen}
          setOfficeOpen={setOfficeOpen}
          pickOffice={pickOffice}
        />
        <div className="w-px h-6 bg-line" />
        {view === "map" ? (
          <>
            <DayPills days={days} dayCounts={dayCounts} toggleDay={toggleDay} />
            {anyFilter && (
              <button
                onClick={clearAll}
                className="border border-line text-ink-dim hover:text-ink text-[12px] px-3 py-1.5 rounded-[8px] transition-colors whitespace-nowrap"
              >
                Clear
              </button>
            )}
          </>
        ) : (
          // Matrix filters via the grid (techs = rows, days = clickable column
          // headers), so this region is intentionally blank — reserved for
          // matrix-level data later.
          <div className="flex-1 min-w-[260px]" />
        )}
      </div>

      {/* ===== CONTENT — side card (same box both views) + main area ===== */}
      <div className="flex-1 min-h-0 flex gap-4">
        <div className="w-[336px] flex-shrink-0">{sideCard}</div>

        <div className="flex-1 min-w-0">
          {view === "matrix" ? (
            <MatrixGrid
              techs={visibleTechs}
              routeByKey={routeByKey}
              selected={selected}
              filteredKeys={filteredKeys}
              anyNarrow={anyDay || anyTech}
              days={days}
              dayCounts={dayCounts}
              onToggleDay={toggleDay}
              onSelect={selectRoute}
            />
          ) : (
            <div className="relative h-full rounded-[16px] overflow-hidden border border-line shadow-card bg-bg">
              <RoutePlannerMap
                token={token}
                stops={mapStops}
                selectedKey={selected}
                hoverKeys={hoverKeys}
                routeLine={routeLine}
                routeLineColor={routeLineColor}
                onSelectRoute={selectRoute}
                height="100%"
              />
              {/* tech chips float over the map's top-right (map-only filter) */}
              <div className="absolute top-3 right-3 z-20 max-w-[calc(100%-24px)] pointer-events-auto">
                <TechChips
                  visibleTechs={visibleTechs}
                  techFilter={techFilter}
                  anyTech={anyTech}
                  onClear={() => setTechFilter({})}
                  onToggle={toggleTech}
                />
              </div>
              {/* day legend (bottom-left) — per-day visibility checkbox + hover a
                  row to scale that day's pins out of a cluster. Shown while the
                  filter has 2+ days; the filter controls which days are listed. */}
              {comparingDays && (
                <DayLegend
                  days={days}
                  dayHidden={dayHidden}
                  onToggleHidden={toggleDayHidden}
                  onHoverDay={setHoverDay}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Top-bar pieces ────────────────────────────────────────────────────────────

function ViewToggle({
  view,
  setView,
}: {
  view: "matrix" | "map"
  setView: (v: "matrix" | "map") => void
}) {
  return (
    <div className="inline-flex bg-bg border border-line rounded-[8px] p-[3px] gap-[2px]">
      {(["matrix", "map"] as const).map((v) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={cn(
            "px-3.5 py-1.5 rounded-[6px] text-[11px] font-mono uppercase tracking-[0.12em] transition-colors",
            view === v ? "bg-cyan/15 text-cyan" : "text-ink-mute hover:text-ink",
          )}
        >
          {v === "matrix" ? "Matrix" : "Map"}
        </button>
      ))}
    </div>
  )
}

function OfficePicker({
  office,
  offices,
  officeOpen,
  setOfficeOpen,
  pickOffice,
}: {
  office: string | null
  offices: string[]
  officeOpen: boolean
  setOfficeOpen: (fn: (o: boolean) => boolean) => void
  pickOffice: (o: string | null) => void
}) {
  return (
    <div className="relative">
      <button
        onClick={() => setOfficeOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOfficeOpen(() => false), 120)}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-[8px] hover:bg-white/[0.04] transition-colors"
      >
        <span className="text-[9px] font-mono uppercase tracking-[0.14em] text-ink-mute">Office</span>
        <span className="text-[12px] font-mono font-semibold text-ink">{office ?? "All"}</span>
        <span className={cn("text-[10px] text-ink-mute transition-transform", officeOpen && "rotate-180")}>
          ▾
        </span>
      </button>
      {officeOpen && (
        <div className="absolute top-[calc(100%+8px)] left-0 z-50 min-w-[160px] bg-bg-elev border border-line rounded-[10px] p-1 shadow-card">
          {[null, ...offices].map((o) => (
            <button
              key={o ?? "__all"}
              onMouseDown={(e) => {
                e.preventDefault()
                pickOffice(o)
              }}
              className={cn(
                "block w-full text-left px-3 py-2 rounded-[6px] text-[11px] font-mono uppercase tracking-[0.08em] transition-colors",
                office === o ? "bg-cyan/10 text-cyan" : "text-ink-dim hover:bg-white/[0.04]",
              )}
            >
              {o ?? "All offices"}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DayPills({
  days,
  dayCounts,
  toggleDay,
}: {
  days: Record<number, boolean>
  dayCounts: Record<number, number>
  toggleDay: (d: number) => void
}) {
  return (
    <div className="grid grid-cols-7 bg-bg border border-line rounded-full overflow-hidden h-9 flex-1 min-w-[260px]">
      {ALL_DAYS.map((d) => (
        <button
          key={d}
          onClick={() => toggleDay(d)}
          className={cn(
            "flex flex-col items-center justify-center border-r border-line-soft last:border-r-0 text-[10px] font-mono uppercase tracking-[0.1em] transition-colors leading-none gap-0.5",
            days[d] ? "bg-cyan/15 text-cyan" : "text-ink-mute hover:text-ink",
          )}
        >
          <span>{DAY_SHORT[d]}</span>
          <span className="text-[8px] opacity-60">{dayCounts[d] ?? 0}</span>
        </button>
      ))}
    </div>
  )
}

// ── Tech filter chips (map view — floats over the map) ───────────────────────

function TechChips({
  visibleTechs,
  techFilter,
  anyTech,
  onClear,
  onToggle,
}: {
  visibleTechs: PlannerTech[]
  techFilter: Record<string, boolean>
  anyTech: boolean
  onClear: () => void
  onToggle: (id: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5 max-h-[92px] overflow-y-auto">
      <button
        onClick={onClear}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors",
          anyTech ? "border-line bg-bg-elev text-ink-dim hover:text-ink" : "border-cyan/40 bg-cyan/10 text-ink",
        )}
      >
        All techs
      </button>
      {visibleTechs.map((t) => (
        <button
          key={t.id}
          onClick={() => onToggle(t.id)}
          className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors whitespace-nowrap",
            techFilter[t.id]
              ? "border-cyan/40 bg-cyan/10 text-ink"
              : "border-line bg-bg-elev text-ink-dim hover:text-ink",
          )}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.color }} />
          {t.name ?? "(no tech)"}
        </button>
      ))}
    </div>
  )
}

// ── Map day legend (bottom-left) — per-day VISIBILITY checkbox (hide a day from
//    view without dropping it from the filter) + hover a row to pop that day's
//    pins. The day filter controls which days are listed. ──────────────────────

function DayLegend({
  days,
  dayHidden,
  onToggleHidden,
  onHoverDay,
}: {
  days: Record<number, boolean>
  dayHidden: Record<number, boolean>
  onToggleHidden: (day: number) => void
  onHoverDay: (day: number | null) => void
}) {
  // selected days, Monday-first
  const selectedDays = ALL_DAYS.filter((d) => days[d]).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
  return (
    <div className="absolute bottom-3 left-3 z-20 bg-bg-elev/90 backdrop-blur-md border border-line rounded-[10px] shadow-card p-1.5 min-w-[132px]">
      <div className="text-[9px] font-mono uppercase tracking-[0.14em] text-ink-mute px-1.5 pt-0.5 pb-1">
        Days
      </div>
      <div className="flex flex-col gap-px">
        {selectedDays.map((d) => {
          const visible = !dayHidden[d]
          return (
            <button
              key={d}
              onClick={() => onToggleHidden(d)}
              onMouseEnter={() => visible && onHoverDay(d)}
              onMouseLeave={() => onHoverDay(null)}
              className="flex items-center gap-2 px-1.5 py-1 rounded-[6px] hover:bg-white/[0.05] transition-colors text-left"
            >
              <span
                className={cn(
                  "w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center flex-shrink-0 transition-colors",
                  visible ? "bg-cyan/20 border-cyan/60" : "bg-transparent border-line",
                )}
              >
                {visible && (
                  <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2.5 6.5l2.5 2.5 4.5-5"
                      stroke="rgb(var(--cyan))"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span className={cn("text-[11px]", visible ? "text-ink" : "text-ink-mute line-through")}>
                {DAY_NAMES[d]}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Matrix view ──────────────────────────────────────────────────────────────

function MatrixGrid({
  techs,
  routeByKey,
  selected,
  filteredKeys,
  anyNarrow,
  days,
  dayCounts,
  onToggleDay,
  onSelect,
}: {
  techs: PlannerTech[]
  routeByKey: Map<string, PlannerRoute>
  selected: string | null
  filteredKeys: Set<string>
  anyNarrow: boolean
  days: Record<number, boolean>
  dayCounts: Record<number, number>
  onToggleDay: (d: number) => void
  onSelect: (key: string) => void
}) {
  return (
    <div className="bg-bg-elev border border-line rounded-lg shadow-card overflow-hidden flex flex-col h-full">
      {/* header row */}
      <div className="flex flex-shrink-0 border-b border-line">
        <div className="flex-[0_0_180px] border-r border-line h-12 flex items-center px-3.5 text-[9px] font-mono uppercase tracking-[0.14em] text-ink-mute">
          Technician
        </div>
        <div className="flex-1 grid grid-cols-7">
          {ALL_DAYS.map((d) => (
            <button
              key={d}
              onClick={() => onToggleDay(d)}
              className={cn(
                "flex flex-col items-center justify-center h-12 border-r border-line-soft last:border-r-0 text-[10px] font-mono uppercase tracking-[0.1em] transition-colors gap-0.5",
                days[d] ? "bg-cyan/[0.08] text-cyan" : "text-ink-mute hover:text-ink",
              )}
            >
              <span>{DAY_SHORT[d]}</span>
              <span className="text-[8px] opacity-50">{dayCounts[d] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* tech rows */}
      <div className="flex-1 overflow-y-auto">
        {techs.length === 0 && (
          <div className="px-4 py-10 text-center text-ink-mute text-[12px]">
            No technicians for this office.
          </div>
        )}
        {techs.map((t) => (
          <div key={t.id} className="flex border-b border-line-soft last:border-b-0">
            <div className="flex-[0_0_180px] border-r border-line-soft h-[60px] flex items-center gap-2.5 px-3.5 text-[12px] text-ink-dim min-w-0">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: t.color }} />
              <span className="truncate">{t.name ?? "(no tech)"}</span>
            </div>
            <div className="flex-1 grid grid-cols-7">
              {ALL_DAYS.map((d) => {
                const key = `${t.id}|${d}`
                const r = routeByKey.get(key)
                const isSelected = selected === key
                const dim = anyNarrow && r && !filteredKeys.has(key)
                return (
                  <button
                    key={d}
                    disabled={!r}
                    onClick={() => r && onSelect(key)}
                    className={cn(
                      "flex flex-col items-center justify-center h-[60px] border-r border-line-soft last:border-r-0 transition-colors",
                      !r && "cursor-default",
                      r && !isSelected && !dim && "hover:bg-white/[0.03] cursor-pointer",
                      isSelected && "bg-cyan/[0.14] ring-1 ring-inset ring-cyan/40",
                      dim && "opacity-30",
                    )}
                  >
                    {r ? (
                      <>
                        <span
                          className={cn(
                            "font-display text-[20px] leading-none",
                            isSelected ? "text-cyan" : "text-ink",
                          )}
                        >
                          {r.stopCount}
                        </span>
                        <span className="text-[8px] font-mono text-ink-mute mt-1">stops</span>
                      </>
                    ) : (
                      <span className="text-[16px] text-line">·</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Map view — route list (lives in the side card) ───────────────────────────

function RouteListPanel({
  routes,
  totalStops,
  selected,
  onSelect,
}: {
  routes: PlannerRoute[]
  totalStops: number
  selected: string | null
  onSelect: (key: string) => void
}) {
  // Route list sorted by tech, then by day Mon→Sun. day is 0=Sun..6=Sat, so
  // remap to a Monday-first index ((day+6)%7 → Mon=0 … Sat=5, Sun=6).
  const mondayIdx = (day: number) => (day + 6) % 7
  const sorted = useMemo(
    () =>
      [...routes].sort((a, b) =>
        (a.techName ?? "") === (b.techName ?? "")
          ? mondayIdx(a.day) - mondayIdx(b.day)
          : (a.techName ?? "").localeCompare(b.techName ?? ""),
      ),
    [routes],
  )
  return (
    <div className={cn(SOLID, "rounded-lg overflow-hidden flex flex-col w-full h-full")}>
      <div className="px-4 py-3 border-b border-line flex items-baseline justify-between flex-shrink-0">
        <h3 className="font-display text-[15px] text-ink">Routes</h3>
        <span className="text-[10px] font-mono text-ink-mute">
          {routes.length} routes · {totalStops} stops
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2">
        {sorted.length === 0 && (
          <div className="px-4 py-8 text-center text-ink-mute text-[12px] leading-relaxed">
            No routes match the current filters.
          </div>
        )}
        {sorted.map((r) => {
          const isSel = r.key === selected
          return (
            <button
              key={r.key}
              onClick={() => onSelect(r.key)}
              className={cn(
                "flex flex-col gap-0.5 w-full text-left border rounded-[10px] p-2.5 transition-colors",
                isSel ? "border-cyan/45 bg-cyan/[0.10]" : "border-line bg-bg/50 hover:border-cyan/30",
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 min-w-0">
                  <TechDayDot techColor={r.color} day={r.day} />
                  <span className="text-[13px] font-medium text-ink truncate">
                    {r.techName ?? "(no tech)"}
                  </span>
                </span>
                <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-ink-mute flex-shrink-0">
                  {DAY_SHORT[r.day]}
                </span>
              </span>
              <span className="text-[10px] font-mono text-ink-mute truncate pl-[21px]">
                {r.office ?? "Unassigned"}
              </span>
              <span className="flex items-center gap-2 text-[10px] font-mono text-ink-dim pl-[21px]">
                <span>{r.stopCount} stops</span>
                <span className="text-line">·</span>
                <span>{freqSummary(r)}</span>
                <span className="text-cyan ml-auto">{formatCurrency(r.totalPriceCents / 100)}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Shared detail panel ──────────────────────────────────────────────────────

function DetailPanel({
  route,
  stops,
  onClose,
}: {
  route: PlannerRoute | null
  stops: PlannerStop[]
  onClose: () => void
}) {
  const shell = cn(SOLID, "rounded-lg w-full h-full")

  if (!route) {
    return (
      <div className={cn(shell, "flex flex-col items-center justify-center text-center px-6 py-12 gap-2.5")}>
        <div className="font-display text-[20px] text-ink-mute leading-tight">Select a route</div>
        <div className="text-[12px] text-ink-mute/70 leading-relaxed max-w-[200px]">
          Click a cell in the grid (or a route in the list) to see its summary and stops here.
        </div>
      </div>
    )
  }

  return (
    <div className={cn(shell, "flex flex-col overflow-hidden")}>
      {/* header */}
      <div
        className="px-4 py-3.5 border-b border-line flex-shrink-0 border-l-[3px]"
        style={{ borderLeftColor: route.color }}
      >
        <button
          onClick={onClose}
          className="inline-flex items-center gap-1.5 text-[12px] text-ink-dim hover:text-ink mb-2.5 transition-colors"
        >
          ‹ Close
        </button>
        <div className="text-[10px] font-mono uppercase tracking-[0.14em]" style={{ color: route.color }}>
          {DAY_NAMES[route.day]} · {route.office ?? "Unassigned"}
        </div>
        <div className="font-display text-[22px] text-ink leading-tight mt-1">
          {route.techName ?? "(no tech)"}
        </div>
      </div>

      {/* stat tiles */}
      <div className="grid grid-cols-2 gap-px bg-line m-4 rounded-[10px] overflow-hidden border border-line flex-shrink-0">
        <StatTile label="Stops" value={String(route.stopCount)} />
        <StatTile label="Revenue / cycle" value={formatCurrency(route.totalPriceCents / 100)} accent />
        <StatTile label="Weekly" value={String(route.weeklyCount)} />
        <StatTile label="Bi / monthly" value={`${route.biweeklyCount} / ${route.monthlyCount}`} />
      </div>

      {/* stop list */}
      <div className="text-[9px] font-mono uppercase tracking-[0.14em] text-ink-mute px-4 pt-3.5 pb-2 flex-shrink-0">
        Stop list
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {stops.length === 0 && (
          <div className="text-[12px] text-ink-mute py-4">No stops on this route.</div>
        )}
        {stops.map((s) => (
          <div key={s.scheduleId} className="py-2.5 border-b border-line-soft last:border-b-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-mono text-ink-mute w-5 flex-shrink-0">
                {s.sequence ?? "—"}
              </span>
              <span className="text-[13px] font-medium text-ink truncate">
                {s.customerName ?? "(unknown)"}
              </span>
            </div>
            <div className="text-[11px] text-ink-mute pl-7">
              {[s.street, s.city].filter(Boolean).join(", ") || "—"}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatTile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-bg-elev px-3 py-2.5">
      <div className="text-[9px] font-mono uppercase tracking-[0.14em] text-ink-mute mb-1.5">{label}</div>
      <div className={cn("font-display text-[22px] leading-none", accent ? "text-cyan" : "text-ink")}>
        {value}
      </div>
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────

function freqSummary(r: PlannerRoute): string {
  const parts: string[] = []
  if (r.weeklyCount > 0) parts.push(`${r.weeklyCount}w`)
  if (r.biweeklyCount > 0) parts.push(`${r.biweeklyCount}bw`)
  if (r.monthlyCount > 0) parts.push(`${r.monthlyCount}mo`)
  return parts.join(" ") || "—"
}
