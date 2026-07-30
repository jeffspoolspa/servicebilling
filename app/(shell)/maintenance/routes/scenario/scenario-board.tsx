"use client"

/**
 * The scenario board — the domain running in the browser.
 *
 * Quotas are rehydrated here from snapshots, a Scenario is opened over them,
 * and every interaction is a domain call: moveStop, placeStop, clearRoute,
 * replay. Routes and their metrics re-derive after each edit because they were
 * never stored. No server round trip, and no rules live in this file — the
 * filters below scope what is *shown*, which is a view concern; they never
 * change what the model computes.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import {
  DriveMatrix,
  fromSnapshot,
  Pin,
  Quota,
  RouteFactory,
  RouteGeometry,
  Scenario,
  WEEKDAY_NAMES,
  type QuotaSnapshot,
  type RoutingEvent,
  type Weekday,
} from "@/lib/domain/routing"

const PALETTE = [
  "#2563eb", "#16a34a", "#db2777", "#d97706", "#7c3aad",
  "#0891b2", "#dc2626", "#65a30d", "#c026d3", "#0d9488",
]
const UNPLACED = "#facc15"

const routeKey = (techId: string, weekday: number) => `${techId}|${weekday}`

type Customer = { name: string; office: string | null }

/** A pill row. Empty selection means "all" — a filter no one has set yet. */
function Pills<T extends string | number>({
  options,
  selected,
  onToggle,
  onClear,
  label,
}: {
  options: { value: T; label: string; count?: number }[]
  selected: Set<T>
  onToggle: (v: T) => void
  onClear: () => void
  label: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        className={`rounded-full border px-2.5 py-0.5 text-xs ${selected.size === 0 ? "border-foreground bg-foreground text-background" : ""}`}
        onClick={onClear}
      >
        All {label}
      </button>
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={`rounded-full border px-2.5 py-0.5 text-xs ${selected.has(o.value) ? "border-foreground bg-foreground text-background" : ""}`}
          onClick={() => onToggle(o.value)}
        >
          {o.label}
          {o.count !== undefined && <span className="ml-1 opacity-60 tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function ScenarioBoard({
  token,
  week,
  quotas: snapshots,
  bases,
  customers,
  techs,
}: {
  token: string | null
  week: number
  quotas: QuotaSnapshot[]
  bases: Record<string, { lat: number; lng: number }>
  customers: Record<number, Customer>
  techs: Record<string, string>
}) {
  // Warm matrix: every leg pre-measured once, edits become lookups.
  const geometry = useMemo(
    () => new RouteGeometry(undefined, DriveMatrix.of(snapshots.map(fromSnapshot))),
    [snapshots],
  )
  const factory = useMemo(
    () =>
      new RouteFactory(
        geometry,
        new Map(Object.entries(bases).map(([id, p]) => [id, Pin.restore(p.lat, p.lng)])),
      ),
    [geometry, bases],
  )
  const base = useMemo(() => () => snapshots.map(fromSnapshot), [snapshots])
  const [scenario, setScenario] = useState<Scenario>(() => Scenario.from(base()))

  const [, forceRender] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  /**
   * Which of the selected quota's placements the next click acts on: an
   * existing stop (move it) or one of the owed slots (place a new one).
   * Owed slots are derived from unmetCount — tokens for this interaction only,
   * with no state and no life beyond it.
   */
  const [slot, setSlot] = useState<{ kind: "stop"; techId: string; weekday: Weekday } | { kind: "owed" } | null>(null)
  const [offices, setOffices] = useState<Set<string>>(new Set())
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set())
  const [card, setCard] = useState<"unplaced" | "changes" | null>(null)
  const [openTech, setOpenTech] = useState<string | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<mapboxgl.Marker[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  // Re-derived on every edit. Keyed on the scenario's own revision, so the
  // view cannot lag the model — there is nothing to invalidate, only to re-ask.
  const rev = scenario.revision
  const routes = useMemo(() => scenario.routes(factory, week), [scenario, factory, week, rev])
  const layer = useMemo(() => scenario.unplacedLayer(), [scenario, rev])
  const blockers = useMemo(() => scenario.adoptionBlockers(), [scenario, rev])
  const changes = useMemo(() => scenario.changes(), [scenario, rev])

  const nameOf = (customerId: number | null) =>
    customerId !== null ? (customers[customerId]?.name ?? "—") : "—"
  const officeOf = (customerId: number | null) =>
    customerId !== null ? (customers[customerId]?.office ?? null) : null
  const techOf = (techId: string) => techs[techId] ?? techId.slice(0, 8)

  /* ----------------------------------------------------------- the filters */

  const officeOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const q of scenario.all) {
      const o = officeOf(q.requirement.customerId)
      if (o) counts.set(o, (counts.get(o) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: value.replace(/, GA$/, ""), count }))
  }, [scenario, customers])

  const inOffice = (customerId: number | null) =>
    offices.size === 0 || offices.has(officeOf(customerId) ?? "")

  /** Routes keep only the stops in scope; a route with none drops out entirely. */
  const visible = useMemo(
    () =>
      routes
        .filter((r) => weekdays.size === 0 || weekdays.has(r.weekday))
        .map((r) => ({ route: r, stops: r.stops.filter((s) => inOffice(s.customerId)) }))
        .filter((v) => v.stops.length > 0),
    [routes, weekdays, offices, customers],
  )

  /** Unplaced quotas ignore the weekday filter — they have no weekday yet. */
  const unplaced = useMemo(
    () =>
      [...layer.displaced.map((d) => d.quota), ...layer.backlog].filter((q) =>
        inOffice(q.requirement.customerId),
      ),
    [layer, offices, customers],
  )
  const queue = useMemo(
    () => unplaced.map((quota) => ({ quota, owed: quota.unmetCount(), fits: geometry.fit(routes, quota, 8) })),
    [unplaced, routes, geometry],
  )
  const owedTotal = queue.reduce((n, q) => n + q.owed, 0)

  /** One colour per tech, so the map reads as territory rather than as days. */
  const colorOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of routes) if (!map.has(r.techId)) map.set(r.techId, PALETTE[map.size % PALETTE.length])
    return map
  }, [routes])

  const byTech = useMemo(() => {
    const groups = new Map<string, typeof visible>()
    for (const v of visible) groups.set(v.route.techId, [...(groups.get(v.route.techId) ?? []), v])
    return [...groups.entries()]
      .map(([techId, rs]) => ({
        techId,
        rs: rs.slice().sort((a, b) => a.route.weekday - b.route.weekday),
        stops: rs.reduce((n, v) => n + v.stops.length, 0),
        peak: Math.max(...rs.map((v) => v.route.heaviest().estimate.utilization)),
      }))
      .sort((a, b) => b.peak - a.peak)
  }, [visible])

  const selectedQuota = selected ? scenario.all.find((q) => q.id === selected) ?? null : null
  const candidates = useMemo(
    () => (selectedQuota ? geometry.fit(routes, selectedQuota, 6) : []),
    [selectedQuota, routes, geometry],
  )

  /* ------------------------------------------------------------------ map */

  useEffect(() => {
    if (!token || !containerRef.current || mapRef.current) return
    mapboxgl.accessToken = token
    mapRef.current = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-81.5, 31.3],
      zoom: 8.2,
    })
    mapRef.current.addControl(new mapboxgl.NavigationControl(), "top-right")
  }, [token])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    for (const m of markersRef.current) m.remove()
    markersRef.current = []

    const placeMarker = (
      lat: number,
      lng: number,
      color: string,
      quotaId: string,
      label: string,
      ring: boolean,
      owed = false,
    ) => {
      const el = document.createElement("button")
      el.type = "button"
      el.title = label
      const size = ring ? 16 : owed ? 14 : 11
      el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;
        background:${color};border:${ring ? "3px solid #111" : owed ? "2px solid #78350f" : "1.5px solid #fff"};
        cursor:pointer;padding:0;box-shadow:0 0 0 1px rgba(0,0,0,.25)${owed ? ";z-index:2" : ""}`
      el.addEventListener("click", (e) => {
        e.stopPropagation()
        setSelected(quotaId)
        setSlot(null)
      })
      markersRef.current.push(new mapboxgl.Marker(el).setLngLat([lng, lat]).addTo(map))
    }

    for (const { route, stops } of visible) {
      const color = colorOf.get(route.techId) ?? UNPLACED
      for (const stop of stops) {
        if (!stop.pin) continue
        placeMarker(
          stop.pin.lat,
          stop.pin.lng,
          color,
          stop.quotaId,
          `${nameOf(stop.customerId)} — ${WEEKDAY_NAMES[route.weekday]} ${techOf(route.techId)}`,
          stop.quotaId === selected,
        )
      }
    }
    // Drawn last so an owed quota is never hidden under a placed pin.
    for (const q of unplaced) {
      const pin = q.requirement.pin
      if (!pin) continue
      placeMarker(
        pin.lat,
        pin.lng,
        UNPLACED,
        q.id,
        `${nameOf(q.requirement.customerId)} — ${q.unmetCount()} owed`,
        q.id === selected,
        true,
      )
    }
  }, [visible, unplaced, colorOf, selected, customers, techs])

  /* -------------------------------------------------------------- actions */

  const act = (fn: () => void) => {
    try {
      fn()
      forceRender((n) => n + 1)
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err))
    }
  }

  const assign = (techId: string, weekday: Weekday) => {
    if (!selectedQuota || !slot) return
    act(() => {
      if (slot.kind === "owed") scenario.placeStop(selectedQuota.id, techId, weekday)
      else scenario.moveStop(selectedQuota.id, { techId: slot.techId, weekday: slot.weekday }, { techId, weekday })
      setSlot(null)
    })
  }

  /**
   * Undo one change by rebuilding the scenario from the live base without it.
   * A scenario *is* its base plus its ordered changes, so dropping one and
   * replaying is the only honest undo — and it fails loudly when the dropped
   * change was the one a later change depended on.
   */
  const revert = (index: number) =>
    act(() => setScenario(Scenario.replay(base(), changes.filter((_, i) => i !== index))))

  const describe = (e: RoutingEvent) => {
    if (e.kind === "StopPlaced") return `place ${WEEKDAY_NAMES[e.to.weekday]} ${techOf(e.to.techId)}`
    if (e.kind === "StopRemoved") return `unplace ${WEEKDAY_NAMES[e.from.weekday]} ${techOf(e.from.techId)}`
    if (e.kind === "StopMoved")
      return `${WEEKDAY_NAMES[e.from.weekday]} ${techOf(e.from.techId)} to ${WEEKDAY_NAMES[e.to.weekday]} ${techOf(e.to.techId)}`
    return `anchor to week ${e.toAnchorWeek % 2 === 0 ? "A" : "B"}`
  }
  const quotaOf = (id: string): Quota | undefined => scenario.all.find((q) => q.id === id)

  /**
   * D4: a route has no office — it reads the offices of its stops, and may span
   * several. Always computed over the route's whole stop list, never the
   * office-filtered subset, or filtering would make every route look single-office.
   */
  const officeMix = (stops: readonly { customerId: number | null }[]) => {
    const mix = new Map<string, number>()
    for (const s of stops) {
      const o = officeOf(s.customerId) ?? "no office"
      mix.set(o, (mix.get(o) ?? 0) + 1)
    }
    return [...mix.entries()].sort((a, b) => b[1] - a[1])
  }

  const totalStops = visible.reduce((n, v) => n + v.stops.length, 0)
  const pill = "rounded-lg border px-3 py-1.5 text-left text-xs"

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-2 p-4">
      <header className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <h1 className="text-lg font-semibold">Scenario board</h1>
        <p className="text-sm text-muted-foreground">
          {visible.length} routes · {totalStops} stops shown ·{" "}
          {blockers.length === 0 ? (
            <span className="font-medium text-emerald-600">adoptable</span>
          ) : (
            <span className="font-medium text-red-600">{blockers.length} blockers</span>
          )}
        </p>
        <span className="text-xs text-muted-foreground">nothing here touches the live plan</span>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Pills
          label="offices"
          options={officeOptions}
          selected={offices}
          onClear={() => setOffices(new Set())}
          onToggle={(v) =>
            setOffices((s) => {
              const next = new Set(s)
              next.has(v) ? next.delete(v) : next.add(v)
              return next
            })
          }
        />
        <div className="flex gap-2">
          <button
            className={`${pill} ${card === "unplaced" ? "border-foreground" : ""} ${owedTotal > 0 ? "border-yellow-500 text-yellow-500" : ""}`}
            onClick={() => setCard(card === "unplaced" ? null : "unplaced")}
          >
            <span className="font-medium tabular-nums">{owedTotal}</span> unplaced
          </button>
          <button
            className={`${pill} ${card === "changes" ? "border-foreground" : ""}`}
            onClick={() => setCard(card === "changes" ? null : "changes")}
          >
            <span className="font-medium tabular-nums">{changes.length}</span> changes
          </button>
        </div>
      </div>

      {card === "unplaced" && (
        <div className="max-h-52 overflow-y-auto rounded-lg border p-2">
          {queue.length === 0 ? (
            <p className="text-xs text-muted-foreground">every quota in scope is fully placed</p>
          ) : (
            <ul className="space-y-1">
              {queue.map(({ quota, owed, fits }) => (
                <li key={quota.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <button
                    className="w-52 truncate text-left font-medium hover:underline"
                    onClick={() => {
                      setSelected(quota.id)
                      setSlot(null)
                    }}
                  >
                    {nameOf(quota.requirement.customerId)}
                  </button>
                  <span className="text-muted-foreground">{officeOf(quota.requirement.customerId) ?? "no office"}</span>
                  {Array.from({ length: owed }, (_, i) => (
                    <select
                      key={`${quota.id}-${i}`}
                      className="rounded border border-dashed bg-transparent px-1 py-0.5 text-[11px]"
                      value=""
                      onChange={(e) => {
                        const [techId, day] = e.target.value.split("|")
                        if (techId) act(() => scenario.placeStop(quota.id, techId, Number(day) as Weekday))
                      }}
                    >
                      <option value="">owed — assign…</option>
                      {fits.map((c) => (
                        <option key={routeKey(c.techId, c.weekday)} value={`${c.techId}|${c.weekday}`}>
                          {WEEKDAY_NAMES[c.weekday]} {techOf(c.techId)} · +{c.insertionMi}mi
                        </option>
                      ))}
                      {fits.length === 0 && <option disabled>no pin — cannot rank routes</option>}
                    </select>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {card === "changes" && (
        <div className="max-h-52 overflow-y-auto rounded-lg border p-2">
          {changes.length === 0 ? (
            <p className="text-xs text-muted-foreground">no changes yet</p>
          ) : (
            <ul className="space-y-1">
              {changes.map((e, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <button
                    className="w-52 truncate text-left font-medium hover:underline"
                    onClick={() => {
                      setSelected(e.quotaId)
                      setSlot(null)
                      setCard(null)
                    }}
                  >
                    {nameOf(quotaOf(e.quotaId)?.requirement.customerId ?? null)}
                  </button>
                  <span className="flex-1 truncate text-muted-foreground">{describe(e)}</span>
                  <button className="rounded border px-1.5 py-0.5" onClick={() => revert(i)}>
                    revert
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <div ref={containerRef} className="min-h-0 flex-1 rounded-lg border" />

        <aside className="flex w-96 min-h-0 flex-col gap-3 overflow-y-auto rounded-lg border p-3 text-sm">
          <Pills
            label="days"
            options={WEEKDAY_NAMES.map((n, i) => ({ value: i, label: n }))}
            selected={weekdays}
            onClear={() => setWeekdays(new Set())}
            onToggle={(v) =>
              setWeekdays((s) => {
                const next = new Set(s)
                next.has(v) ? next.delete(v) : next.add(v)
                return next
              })
            }
          />

          {selectedQuota && (
            <section className="rounded border p-2">
              <h2 className="font-semibold">{nameOf(selectedQuota.requirement.customerId)}</h2>
              <p className="text-xs text-muted-foreground">
                {officeOf(selectedQuota.requirement.customerId) ?? "no office"} · needs{" "}
                {selectedQuota.requirement.requiredDays} · placed {selectedQuota.stops.length} · owed{" "}
                {selectedQuota.unmetCount()}
              </p>
              <ul className="mt-2 space-y-1">
                {selectedQuota.stops.map((s) => {
                  const active = slot?.kind === "stop" && slot.techId === s.techId && slot.weekday === s.weekday
                  return (
                    <li key={routeKey(s.techId, s.weekday)} className="flex items-center gap-2">
                      <button
                        className={`flex-1 rounded border px-2 py-0.5 text-left text-xs ${active ? "border-blue-600 bg-blue-50 font-medium" : ""}`}
                        onClick={() => setSlot({ kind: "stop", techId: s.techId, weekday: s.weekday })}
                      >
                        {WEEKDAY_NAMES[s.weekday]} · {techOf(s.techId)}
                        {active ? " — pick a route" : ""}
                      </button>
                      <button
                        className="rounded border px-2 py-0.5 text-xs"
                        onClick={() => act(() => scenario.unplaceStop(selectedQuota.id, s.techId, s.weekday))}
                      >
                        unplace
                      </button>
                    </li>
                  )
                })}
                {Array.from({ length: selectedQuota.unmetCount() }, (_, i) => (
                  <li key={`owed-${i}`}>
                    <button
                      className={`w-full rounded border border-dashed px-2 py-0.5 text-left text-xs ${slot?.kind === "owed" ? "border-blue-600 bg-blue-50 font-medium" : "text-muted-foreground"}`}
                      onClick={() => setSlot({ kind: "owed" })}
                    >
                      owed placement{slot?.kind === "owed" ? " — pick a route" : ""}
                    </button>
                  </li>
                ))}
              </ul>

              {slot && (
                <>
                  <h3 className="mt-3 text-xs font-semibold uppercase text-muted-foreground">
                    Cheapest routes to take it
                  </h3>
                  <ul className="mt-1 space-y-1">
                    {candidates.map((c) => (
                      <li key={routeKey(c.techId, c.weekday)}>
                        <button
                          className="w-full rounded border px-2 py-1 text-left text-xs hover:bg-accent"
                          onClick={() => assign(c.techId, c.weekday as Weekday)}
                        >
                          {WEEKDAY_NAMES[c.weekday]} {techOf(c.techId)} · +{c.insertionMi}mi · to{" "}
                          {Math.round(c.newUtilization * 100)}%
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          <section>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
              Techs ({byTech.length})
            </h3>
            <ul className="mt-1 space-y-0.5">
              {byTech.map(({ techId, rs, stops, peak }) => (
                <li key={techId}>
                  <button
                    className="flex w-full items-center gap-2 rounded px-1 py-1 text-xs hover:bg-accent"
                    onClick={() => setOpenTech(openTech === techId ? null : techId)}
                  >
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: colorOf.get(techId) }}
                    />
                    <span className="flex-1 truncate text-left font-medium">{techOf(techId)}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {rs.length}d · {stops} · {Math.round(peak * 100)}%
                    </span>
                    <span className="text-muted-foreground">{openTech === techId ? "−" : "+"}</span>
                  </button>

                  {openTech === techId &&
                    rs.map(({ route, stops: shown }) => (
                      <div key={route.weekday} className="ml-4 border-l pl-2">
                        <div className="flex items-center gap-2 py-0.5 text-xs">
                          <span className="flex-1 font-medium">{WEEKDAY_NAMES[route.weekday]}</span>
                          <span className="tabular-nums text-muted-foreground">
                            {route.stops.length} ·{" "}
                            {Math.round(route.heaviest().estimate.utilization * 100)}% ·{" "}
                            {Math.round(route.heaviest().estimate.driveMi)}mi
                          </span>
                          <button
                            className="rounded border px-1.5 py-0.5"
                            onClick={() => act(() => scenario.clearRoute(route.techId, route.weekday))}
                          >
                            clear
                          </button>
                        </div>
                        {officeMix(route.stops).length > 1 && (
                          <div className="pb-0.5 text-[10px] text-muted-foreground">
                            spans{" "}
                            {officeMix(route.stops)
                              .map(([o, n]) => `${o.replace(/, GA$/, "")} ${n}`)
                              .join(" · ")}
                          </div>
                        )}
                        <ul>
                          {shown.map((s) => (
                            <li key={s.quotaId}>
                              <button
                                className={`w-full truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-accent ${s.quotaId === selected ? "bg-accent font-medium" : "text-muted-foreground"}`}
                                onClick={() => {
                                  setSelected(s.quotaId)
                                  setSlot(null)
                                }}
                              >
                                {nameOf(s.customerId)}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                </li>
              ))}
              {byTech.length === 0 && (
                <li className="text-xs text-muted-foreground">no routes match these filters</li>
              )}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}
