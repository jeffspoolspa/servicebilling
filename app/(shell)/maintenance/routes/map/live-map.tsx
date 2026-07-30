"use client"

/**
 * Territory map, live. The domain runs in the browser: quotas are rehydrated
 * from snapshots, routes and their geometry re-derive here, and nothing is
 * stored that can be computed. Panels float over the map rather than sitting
 * beside it, so the map keeps the full canvas.
 *
 * This view is read-only on purpose. Editing lands on top of it (scenario mode)
 * rather than beside it, so there is one map component, not two.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { OptionPills } from "@/components/ui/option-pills"
import { OfficeFilter } from "../_components/office-filter"
import type { Office } from "@/lib/infrastructure/routing/offices"
import {
  baseIdOf,
  Circle,
  CostModel,
  DriveMatrix,
  fromSnapshot,
  Route,
  RouteFactory,
  RouteGeometry,
  Scenario,
  WEEKDAY_NAMES,
  type QuotaSnapshot,
  Pin,
  type ReassignReport,
  type RoutingEvent,
  type SelectedStop,
  type Weekday,
} from "@/lib/domain/routing"

type Customer = { name: string; office: string | null }
type LatLng = { lat: number; lng: number }
/** A drawn shape as the two ends of its diameter: the anchor, and where you dragged to. */
type Span = { anchor: LatLng; edge: LatLng }

const stopKey = (s: { quotaId: string; techId: string; weekday: number }) =>
  `${s.quotaId}|${s.techId}|${s.weekday}`

/** The Circle a span describes, or null while it is still degenerate. */
function spanOf(span: Span): Circle | null {
  const a = Pin.hypothetical(span.anchor.lat, span.anchor.lng)
  const b = Pin.hypothetical(span.edge.lat, span.edge.lng)
  return a.distanceTo(b) > 0 ? Circle.acrossDiameter(a, b) : null
}
const routeKey = (techId: string, weekday: number) => `${techId}|${weekday}`

/** Colour is per tech — whose day a pin belongs to is the thing you read off the map. */
const PALETTE = [
  "#38bdf8", "#34d399", "#f472b6", "#fbbf24", "#a78bfa",
  "#22d3ee", "#fb7185", "#a3e635", "#e879f9", "#2dd4bf",
  "#60a5fa", "#facc15", "#f87171", "#4ade80", "#c084fc",
]
const NO_TECH_COLOR = "#94a3b8"
const TOUR_TRACE_COLOR = "#94a3b8"
const TOUR_TRACE_HIGHLIGHT = "#7dd3fc"
const TOUR_TRACE_HALO = "#0ea5e9"
const OFFICE_MARKER_COLOR = "#f8fafc"
const glass =
  "rounded-lg border border-line-soft bg-[#0b1620]/85 backdrop-blur-md shadow-xl shadow-black/40"

export function LiveMap({
  token,
  week,
  quotas: snapshots,
  offices,
  bases,
  customers,
  techs,
}: {
  token: string | null
  week: number
  quotas: QuotaSnapshot[]
  offices: Office[]
  /** techId → branch pin: where each tech's day starts and ends. */
  bases: Record<string, { lat: number; lng: number }>
  customers: Record<number, Customer>
  techs: Record<string, string>
}) {
  // The drive matrix loads once per page — every pair pre-measured — so
  // scenario edits and pricing are pure lookups, no trig in the loop.
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
  // Scenario is used here only as a container for the live quotas — nothing on
  // this page edits it. Scenario mode will reuse the same object with the edit
  // methods enabled.
  // State, not a memo: reverting one change rebuilds the plan by replaying the
  // rest over the live base, which swaps the object rather than mutating it.
  const base = useMemo(() => () => snapshots.map(fromSnapshot), [snapshots])
  const [plan, setPlan] = useState<Scenario>(() => Scenario.from(base()))
  /** Bumped when the matrix learns measured legs — estimates must re-derive. */
  const [matrixRev, setMatrixRev] = useState(0)
  const rev = plan.revision
  const routes = useMemo(() => plan.routes(factory, week), [plan, factory, week, rev, matrixRev])
  const layer = useMemo(() => plan.unplacedLayer(), [plan, rev])
  const changes = useMemo(() => plan.changes(), [plan, rev])

  const [officeScope, setOfficeScope] = useState<string[]>([])
  const [dayScope, setDayScope] = useState<string[]>([])

  const [selected, setSelected] = useState<string | null>(null)
  /**
   * The draw tool. `armed` waits for the click that drops the anchor; the shape
   * then grows with the cursor until a second click settles it into `shapes`.
   * Anchor and cursor are the two ends of a diameter, so the anchor stays put
   * on the edge and the circle balloons away from it.
   */
  const [armed, setArmed] = useState(false)
  const [shapes, setShapes] = useState<Span[]>([])
  const [drawing, setDrawing] = useState<Span | null>(null)
  const [report, setReport] = useState<ReassignReport | null>(null)
  /** Stops struck off the selection by hand — the shapes still contain them. */
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [list, setList] = useState<"changes" | "owed" | null>(null)
  const [routesOpen, setRoutesOpen] = useState(true)
  /**
   * The one selected route (tech|day key). Selecting filters the map to that
   * route's stops, draws its tour, and opens the route panel on the left;
   * clearing returns to everything the office and day filters allow.
   */
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null)
  /** One leg of the selected tour ("fromId>toId"), picked on map or panel. */
  const [selectedLeg, setSelectedLeg] = useState<string | null>(null)
  const [, forceRender] = useState(0)

  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<mapboxgl.Marker[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const boundsRef = useRef<mapboxgl.LngLatBounds | null>(null)
  // The map's handlers are bound once, so they must read live state.
  const armedRef = useRef(false)
  const drawingRef = useRef<Span | null>(null)
  armedRef.current = armed
  drawingRef.current = drawing
  // While the draw tool is live, a click belongs to the map, not to whatever
  // pin happens to be under the cursor.
  const drawActive = armed || drawing !== null
  const fitted = useRef(false)

  /**
   * Frame the stops, but only once the container actually has a size — the
   * first paint measures zero, and fitting an empty box silently wastes the
   * one fit we get.
   */
  const fitIfReady = () => {
    const map = mapRef.current
    const bounds = boundsRef.current
    if (!map || fitted.current || !bounds || bounds.isEmpty()) return
    if (map.getContainer().clientHeight < 50) return
    map.fitBounds(bounds, { padding: 64, maxZoom: 12, duration: 0 })
    fitted.current = true
  }

  const nameOf = (id: number | null) => (id !== null ? (customers[id]?.name ?? "—") : "—")
  const officeOf = (id: number | null) => (id !== null ? (customers[id]?.office ?? null) : null)
  const techOf = (id: string) => techs[id] ?? id.slice(0, 8)
  /**
   * Assigned over ALL routes, not the visible ones, so a tech keeps their colour
   * when the office or day scope changes.
   */
  const techColor = useMemo(() => {
    const ids = [...new Set(routes.map((r) => r.techId))].sort()
    return new Map(ids.map((id, i) => [id, PALETTE[i % PALETTE.length]]))
  }, [routes])
  const colorOf = (techId: string | null) =>
    (techId && techColor.get(techId)) || NO_TECH_COLOR

  /* ---------------------------------------------------------------- scope */

  const inOffice = (id: number | null) =>
    officeScope.length === 0 || officeScope.includes(officeOf(id) ?? "")
  const inDay = (d: number) => dayScope.length === 0 || dayScope.includes(String(d))

  /** Routes keep only the stops in scope; a route left with none drops out. */
  const visible = useMemo(
    () =>
      routes
        .filter((r) => inDay(r.weekday))
        .map((r) => ({ route: r, stops: r.stops.filter((s) => inOffice(s.customerId)) }))
        .filter((v) => v.stops.length > 0),
    [routes, dayScope, officeScope, customers],
  )

  const unplaced = useMemo(
    () => [...layer.displaced.map((d) => d.quota), ...layer.backlog].filter((q) => inOffice(q.requirement.customerId)),
    [layer, officeScope, customers],
  )

  const officeCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const q of plan.all) {
      const o = officeOf(q.requirement.customerId)
      if (o) c[o] = (c[o] ?? 0) + 1
    }
    return c
  }, [plan, customers])

  /**
   * The cost model prices routes for the cards and every pending change for
   * the unpublished box. All domain — the UI only formats.
   */
  const costModel = useMemo(() => new CostModel(geometry, factory), [geometry, factory])

  /** Route cards, day-grouped when more than one day is in scope; heaviest first within a day. */
  const byDay = useMemo(() => {
    const costed = visible.map((v) => ({ route: v.route, cost: costModel.ofRoute(v.route) }))
    const days = new Map<Weekday, typeof costed>()
    for (const c of costed) days.set(c.route.weekday, [...(days.get(c.route.weekday) ?? []), c])
    return [...days.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([weekday, dayRoutes]) => ({
        weekday,
        routes: dayRoutes.sort((a, b) => b.cost.utilization - a.cost.utilization),
      }))
  }, [visible, costModel])



  const selectedInfo = useMemo(() => {
    if (!selected) return null
    const quota = plan.all.find((q) => q.id === selected)
    if (!quota) return null
    const hit = visible.find((v) => v.route.stops.some((s) => s.quotaId === selected))
    return {
      quota,
      route: hit?.route ?? null,
      profile: hit?.route.profileOf(selected) ?? null,
    }
  }, [selected, plan, visible])

  /**
   * Derived, not stored: re-asking the domain after every edit is what keeps
   * the panel honest once stops start moving.
   */
  const selection = useMemo(() => {
    const regions = shapes.map(spanOf).filter((c): c is Circle => c !== null)
    if (regions.length === 0) return null
    return plan
      .placementsWithin(regions, dayScope.map((d) => Number(d) as Weekday))
      .filter((s) => !excluded.has(stopKey(s)))
  }, [shapes, plan, dayScope, rev, excluded])

  const pickedKeys = useMemo(() => new Set((selection ?? []).map(stopKey)), [selection])

  /** Techs who already hold a route — the plausible targets for a reassignment. */
  const techOptions = useMemo(
    () =>
      [...new Set(routes.map((r) => r.techId))]
        .map((id) => ({ id, name: techOf(id) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [routes, techs],
  )

  /* ------------------------------------------------------------------ map */

  useEffect(() => {
    if (!token || !containerRef.current || mapRef.current) return
    mapboxgl.accessToken = token
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-81.4, 31.4],
      zoom: 8,
      attributionControl: false,
    })
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-right")
    mapRef.current = map

    map.on("load", () => {
      map.addSource("lasso", { type: "geojson", data: { type: "FeatureCollection", features: [] } })
      map.addLayer({ id: "lasso-fill", type: "fill", source: "lasso", paint: { "fill-color": "#22d3ee", "fill-opacity": 0.12 } })
      map.addLayer({ id: "lasso-line", type: "line", source: "lasso", paint: { "line-color": "#22d3ee", "line-width": 2, "line-dasharray": [2, 1] } })
      map.addSource("tour", { type: "geojson", data: { type: "FeatureCollection", features: [] } })
      map.addLayer({
        id: "tour-body",
        type: "line",
        source: "tour",
        filter: ["==", ["get", "kind"], "body"],
        paint: {
          "line-color": TOUR_TRACE_COLOR,
          "line-width": 2.5,
          "line-opacity": 0.72,
        },
      })
      map.addLayer({
        id: "tour-highlight-halo",
        type: "line",
        source: "tour",
        filter: ["all", ["==", ["get", "kind"], "body"], ["==", ["get", "sel"], true]],
        paint: {
          "line-color": TOUR_TRACE_HALO,
          "line-width": 9,
          "line-opacity": 0.55,
          "line-blur": 1,
        },
      })
      map.addLayer({
        id: "tour-highlight",
        type: "line",
        source: "tour",
        filter: ["all", ["==", ["get", "kind"], "body"], ["==", ["get", "sel"], true]],
        paint: {
          "line-color": TOUR_TRACE_HIGHLIGHT,
          "line-width": 5.5,
          "line-opacity": 1,
        },
      })
      // Legs are objects: a wide invisible strip makes each one honestly
      // clickable, not a pixel-hunt along a 2px line.
      map.addLayer({
        id: "tour-hit",
        type: "line",
        source: "tour",
        filter: ["==", ["get", "kind"], "body"],
        paint: { "line-color": "#000", "line-opacity": 0.001, "line-width": 16 },
      })
      map.on("click", "tour-hit", (e) => {
        const legId = e.features?.[0]?.properties?.legId as string | undefined
        if (legId) setSelectedLeg((cur) => (cur === legId ? null : legId))
      })
      map.on("mouseenter", "tour-hit", () => {
        map.getCanvas().style.cursor = "pointer"
      })
      map.on("mouseleave", "tour-hit", () => {
        map.getCanvas().style.cursor = ""
      })
      map.addSource("lasso-centre", { type: "geojson", data: { type: "FeatureCollection", features: [] } })
      map.addLayer({
        id: "lasso-centre",
        type: "circle",
        source: "lasso-centre",
        paint: {
          "circle-radius": 4,
          "circle-color": "#22d3ee",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#0b1620",
        },
      })
    })
    map.on("click", (e) => {
      const here = { lat: e.lngLat.lat, lng: e.lngLat.lng }
      if (armedRef.current) {
        setArmed(false)
        setDrawing({ anchor: here, edge: here })
        return
      }
      const live = drawingRef.current
      if (live && spanOf(live)) {
        setShapes((prev) => [...prev, live])
        setDrawing(null)
      }
    })
    map.on("mousemove", (e) => {
      const live = drawingRef.current
      if (!live) return
      setDrawing({ anchor: live.anchor, edge: { lat: e.lngLat.lat, lng: e.lngLat.lng } })
    })

    // The container is sized by flex/absolute layout that settles after mount,
    // so mapbox's initial measurement is short and the canvas never grows on
    // its own. Watch the box instead of guessing a timeout.
    const ro = new ResizeObserver(() => {
      map.resize()
      fitIfReady()
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [token])

  useEffect(() => {
    const map = mapRef.current
    const src = map?.getSource("lasso") as mapboxgl.GeoJSONSource | undefined
    if (!src) return
    const onScreen = [...shapes, ...(drawing ? [drawing] : [])]
    src.setData({
      type: "FeatureCollection",
      features: onScreen.flatMap((span) => {
        const c = spanOf(span)
        if (!c) return []
        return [
          {
            type: "Feature" as const,
            properties: {},
            geometry: {
              type: "Polygon" as const,
              coordinates: [c.ring().map((p) => [p.lng, p.lat])],
            },
          },
        ]
      }),
    })
    const anchorSrc = map!.getSource("lasso-centre") as mapboxgl.GeoJSONSource | undefined
    anchorSrc?.setData({
      type: "FeatureCollection",
      features: onScreen.map((span) => ({
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Point" as const, coordinates: [span.anchor.lng, span.anchor.lat] },
      })),
    })

    // Mapbox's double-click zoom fires on the pair of clicks that define a
    // shape, panning the map out from under the anchor you just set.
    if (drawActive) map!.doubleClickZoom.disable()
    else map!.doubleClickZoom.enable()
    map!.getCanvas().style.cursor = drawActive ? "crosshair" : ""
  }, [shapes, drawing, armed, drawActive])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    for (const m of markersRef.current) m.remove()
    markersRef.current = []
    const bounds = new mapboxgl.LngLatBounds()

    const put = (
      lat: number,
      lng: number,
      color: string,
      quotaId: string,
      title: string,
      opts: { ring?: boolean; owed?: boolean; picked?: boolean } = {},
    ) => {
      const el = document.createElement("button")
      el.type = "button"
      el.title = title
      const size = opts.ring ? 17 : opts.picked ? 15 : opts.owed ? 15 : 11
      const border = opts.ring
        ? "3px solid #22d3ee"
        : opts.picked
          ? "2.5px solid #f8fafc"
          : opts.owed
            ? "2px solid #fbbf24"
            : "1.5px solid #0b1620"
      el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${color};
        border:${border};cursor:pointer;padding:0;opacity:${opts.picked ? 1 : 0.92};
        ${opts.picked ? "box-shadow:0 0 0 3px rgba(248,250,252,.35);z-index:2;" : ""}${opts.ring ? "z-index:3;" : ""}`

      el.addEventListener("click", (e) => {
        e.stopPropagation()
        setSelected(quotaId)
      })
      markersRef.current.push(new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map))
      bounds.extend([lng, lat])
    }

    const putOffice = (lat: number, lng: number, title: string) => {
      const el = document.createElement("button")
      el.type = "button"
      el.title = title
      el.style.cssText = `width:25px;height:25px;border-radius:8px;background:#0b1620;
        border:2px solid ${OFFICE_MARKER_COLOR};color:${OFFICE_MARKER_COLOR};
        display:grid;place-items:center;padding:0;cursor:pointer;
        box-shadow:0 0 0 3px rgba(14,165,233,.28),0 8px 20px rgba(0,0,0,.38);`
      el.innerHTML = `
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path d="M3 10.5 12 4l9 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M5.5 9.5V20h13V9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M10 20v-5h4v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`
      el.addEventListener("click", (e) => {
        e.stopPropagation()
        setSelected(null)
      })
      markersRef.current.push(new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map))
      bounds.extend([lng, lat])
    }

    // Placed stops first, owed next, route office last so the selected tour has a clear anchor.
    const drawn: { fn: () => void; rank: number }[] = []
    const shown = selectedRoute
      ? visible.filter((v) => routeKey(v.route.techId, v.route.weekday) === selectedRoute)
      : visible
    for (const { route, stops } of shown) {
      if (selectedRoute && route.base) {
        drawn.push({
          rank: 2,
          fn: () =>
            putOffice(
              route.base!.lat,
              route.base!.lng,
              `Office — ${WEEKDAY_NAMES[route.weekday]} ${techOf(route.techId)} start/end`,
            ),
        })
      }
      for (const s of stops) {
        if (!s.pin) continue
        drawn.push({
          rank: 0,
          fn: () =>
            put(
              s.pin!.lat,
              s.pin!.lng,
              colorOf(route.techId),
              s.quotaId,
              `${nameOf(s.customerId)} — ${WEEKDAY_NAMES[route.weekday]} ${techOf(route.techId)}`,
              { ring: s.quotaId === selected, picked: pickedKeys.has(`${s.quotaId}|${route.techId}|${route.weekday}`) },
            ),
        })
      }
    }
    for (const q of unplaced) {
      const pin = q.requirement.pin
      if (!pin) continue
      drawn.push({
        rank: 1,
        fn: () =>
          put(pin.lat, pin.lng, colorOf(null), q.id,
            `${nameOf(q.requirement.customerId)} — ${q.unmetCount()} owed`,
            { ring: q.id === selected, owed: true }),
      })
    }
    for (const d of drawn.sort((a, b) => a.rank - b.rank)) d.fn()

    boundsRef.current = bounds
    fitIfReady()
  }, [visible, selectedRoute, unplaced, selected, pickedKeys, colorOf, customers, techs])

  const quotaOf = (id: string) => plan.all.find((q) => q.id === id)

  const analysis = useMemo(() => {
    if (changes.length === 0) return null
    // A pricing failure downgrades to "no numbers", never to a dead page.
    try {
      return costModel.analyze(base(), changes, week)
    } catch (err) {
      console.error("cost analysis failed:", err)
      return null
    }
  }, [costModel, base, changes, week, matrixRev, rev])

  /**
   * The tour line: drawn only when exactly one route is highlighted, so it
     * never crowds a busy map. Traced along actual roads via Mapbox Directions
     * (a display concern — the domain's minutes stay on the matrix until real
     * road times land there), falling back to straight legs if the request
     * fails. Cached per route so re-highlighting is instant.
   */
  /** Road coordinates per leg (legId → coords), cached per route + stop-set. */
  const tourCache = useRef(new Map<string, Map<string, [number, number][]>>())
  const legFetches = useRef(new Set<string>())
  useEffect(() => {
    const map = mapRef.current
    const src = map?.getSource("tour") as mapboxgl.GeoJSONSource | undefined
    if (!src) return
    const empty = { type: "FeatureCollection" as const, features: [] }
    if (!selectedRoute) {
      src.setData(empty)
      return
    }
    const hit = visible.find((v) => routeKey(v.route.techId, v.route.weekday) === selectedRoute)
    if (!hit) {
      src.setData(empty)
      return
    }
    const run = hit.route.heaviest()
    const base = hit.route.base
    const stopPts = run.stops
      .filter((st) => st.pin !== null)
      .map((st) => ({ id: st.quotaId, pin: st.pin! }))
    if (stopPts.length === 0) {
      src.setData(empty)
      return
    }
    const ringPts = base
      ? [{ id: baseIdOf(base), pin: base }, ...stopPts, { id: baseIdOf(base), pin: base }]
      : stopPts
    const cacheKey = `${selectedRoute}|${run.stops.map((st) => st.quotaId).join(",")}`

    /** Each leg is its own feature - clickable and individually lit. */
    const featuresFrom = (roads: Map<string, [number, number][]> | null): GeoJSON.Feature[] =>
      ringPts.slice(0, -1).map((a, i) => {
        const b = ringPts[i + 1]
        const legId = `${a.id}>${b.id}`
        return {
          type: "Feature",
          properties: {
            kind: "body",
            legId,
            sel: legId === selectedLeg,
          },
          geometry: {
            type: "LineString",
            coordinates: roads?.get(legId) ?? [
              [a.pin.lng, a.pin.lat],
              [b.pin.lng, b.pin.lat],
            ],
          },
        }
      })

    const cached = tourCache.current.get(cacheKey) ?? null
    src.setData({ type: "FeatureCollection", features: featuresFrom(cached) })
    if (cached || ringPts.length < 2 || !token) return

    type DirectionsRoute = {
      geometry?: GeoJSON.LineString
      legs?: { steps?: { geometry?: GeoJSON.LineString }[] }[]
    }
    type DirectionsBody = { routes?: DirectionsRoute[] }
    const coordinatesOf = (route: DirectionsRoute | undefined, legIndex?: number): [number, number][] | null => {
      const steps = legIndex !== undefined ? route?.legs?.[legIndex]?.steps : null
      const fromSteps = steps?.flatMap((step) => step.geometry?.coordinates ?? []) as [number, number][] | undefined
      if (fromSteps && fromSteps.length > 1) return fromSteps
      const fromRoute = route?.geometry?.coordinates as [number, number][] | undefined
      return fromRoute && fromRoute.length > 1 ? fromRoute : null
    }
    const directionsUrl = (points: typeof ringPts, steps: boolean) => {
      const path = points.map((c) => `${c.pin.lng},${c.pin.lat}`).join(";")
      const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${path}`)
      url.searchParams.set("geometries", "geojson")
      url.searchParams.set("overview", "full")
      url.searchParams.set("continue_straight", "false")
      url.searchParams.set("radiuses", points.map(() => "unlimited").join(";"))
      url.searchParams.set("steps", String(steps))
      url.searchParams.set("access_token", token)
      return url.toString()
    }
    const fetchLegTrace = async (a: (typeof ringPts)[number], b: (typeof ringPts)[number]) => {
      const res = await fetch(directionsUrl([a, b], false), { signal: aborter.signal })
      if (!res.ok) return null
      const body = (await res.json()) as DirectionsBody
      return coordinatesOf(body.routes?.[0])
    }
    const aborter = new AbortController()
    ;(async () => {
      const roads = new Map<string, [number, number][]>()
      for (let i = 0; i < ringPts.length - 1; i += 24) {
        const chunk = ringPts.slice(i, Math.min(i + 25, ringPts.length))
        if (chunk.length < 2 || aborter.signal.aborted) break

        let tracedChunk = false
        try {
          const url = directionsUrl(chunk, true)
          const res = await fetch(url, { signal: aborter.signal })
          if (!res.ok) throw new Error(`directions ${res.status}`)
          const body = (await res.json()) as DirectionsBody
          const route = body.routes?.[0]
          if (!route?.legs) throw new Error("no route legs")
          route.legs.forEach((_leg, j) => {
            const a = ringPts[i + j]
            const b = ringPts[i + j + 1]
            const coords = coordinatesOf(route, j)
            if (coords) roads.set(`${a.id}>${b.id}`, coords)
          })
          tracedChunk = route.legs.length === chunk.length - 1
        } catch {
          tracedChunk = false
        }

        // If one waypoint knocks out the batch, salvage every other leg.
        if (!tracedChunk) {
          for (let j = 0; j < chunk.length - 1; j += 1) {
            if (aborter.signal.aborted) break
            const a = chunk[j]
            const b = chunk[j + 1]
            const coords = await fetchLegTrace(a, b).catch(() => null)
            if (coords) roads.set(`${a.id}>${b.id}`, coords)
          }
        }

        if (!aborter.signal.aborted) {
          src.setData({ type: "FeatureCollection", features: featuresFrom(roads) })
        }
      }
      tourCache.current.set(cacheKey, roads)
      if (!aborter.signal.aborted) {
        src.setData({ type: "FeatureCollection", features: featuresFrom(roads) })
      }
    })()
    return () => aborter.abort()
  }, [selectedRoute, selectedLeg, visible, token])

  /**
   * Learn real drive times for the highlighted route: one computeRouteMatrix
   * call for office + stops gives the full asymmetric grid, folded into the
   * DriveMatrix — after which every estimate touching this route (cards,
   * pending-box costs, route-panel legs) re-derives on measured minutes. Failures
   * leave the estimates standing; the fetch is attempted once per stop-set.
   */
  useEffect(() => {
    if (!selectedRoute) return
    const hit = visible.find((v) => routeKey(v.route.techId, v.route.weekday) === selectedRoute)
    if (!hit) return
    const run = hit.route.heaviest()
    const base = hit.route.base
    const points = [
      ...(base ? [{ id: baseIdOf(base), lat: base.lat, lng: base.lng }] : []),
      ...run.stops.filter((st) => st.pin !== null).map((st) => ({ id: st.quotaId, lat: st.pin!.lat, lng: st.pin!.lng })),
    ]
    if (points.length < 2 || points.length > 25) return
    const fetchKey = points.map((p) => p.id).join(",")
    if (legFetches.current.has(fetchKey)) return
    if (geometry.matrix.hasMeasured(points.map((p) => p.id))) return
    legFetches.current.add(fetchKey)
    ;(async () => {
      try {
        const res = await fetch("/api/routing/leg-times", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points }),
        })
        if (!res.ok) throw new Error(`leg-times ${res.status}`)
        const body = (await res.json()) as { legs: { fromId: string; toId: string; minutes: number; miles: number }[] }
        if (body.legs?.length) {
          geometry.matrix.learn(body.legs)
          setMatrixRev((n) => n + 1)
        }
      } catch (err) {
        console.warn("leg times unavailable, estimates stand:", err)
      }
    })()
  }, [selectedRoute, visible, geometry])

  /**
   * The selected route, prepared for the panel: cost, and the tour as rows of
   * (stop, leg-in) with office anchors at both ends. Legs price through
   * legRoadBetween, so they show measured minutes the moment the matrix learns.
   */
  const routePanel = useMemo(() => {
    if (!selectedRoute) return null
    const hit = visible.find((v) => routeKey(v.route.techId, v.route.weekday) === selectedRoute)
    if (!hit) return null
    const run = hit.route.heaviest()
    const cost = costModel.ofRoute(hit.route)
    const base = hit.route.base
    const anchor = base
      ? ({ pin: base, orderingConstraint: "none", quotaId: baseIdOf(base) } as const)
      : null
    const pinned = run.stops.filter((st) => st.pin !== null)
    const rows = pinned.map((stop, i) => {
      const prev = i === 0 ? anchor : pinned[i - 1]
      return {
        stop,
        legIn: prev ? geometry.legRoadBetween(prev, stop) : null,
        legId: prev ? `${prev.quotaId}>${stop.quotaId}` : null,
      }
    })
    const legOut =
      anchor && pinned.length > 0 ? geometry.legRoadBetween(pinned[pinned.length - 1], anchor) : null
    const legOutId =
      anchor && pinned.length > 0 ? `${pinned[pinned.length - 1].quotaId}>${anchor.quotaId}` : null
    return {
      route: hit.route,
      cost,
      rows,
      legOut,
      legOutId,
      unpinned: run.stops.filter((st) => st.pin === null),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoute, visible, costModel, geometry, matrixRev])

  /* -------------------------------------------------------------- actions */

  const clearAll = () => {
    setArmed(false)
    setShapes([])
    setDrawing(null)
    setReport(null)
    setExcluded(new Set())
  }

  const removeShape = (i: number) => {
    setShapes((prev) => prev.filter((_, j) => j !== i))
    setExcluded(new Set())
    setReport(null)
  }

  const revertChange = (index: number) => {
    setPlan(Scenario.replay(base(), changes.filter((_, i) => i !== index)))
    setReport(null)
  }

  const revertAll = () => {
    setPlan(Scenario.from(base()))
    setReport(null)
  }

  const applyReassign = (techId: string, weekday: Weekday) => {
    if (!selection?.length) return
    setReport(plan.reassign(selection, techId, weekday))
    forceRender((n) => n + 1)
  }

  /* --------------------------------------------------------------- render */

  const owed = unplaced.reduce((n, q) => n + q.unmetCount(), 0)

  if (!token) {
    return (
      <div className="px-7 py-10 text-[12px] text-ink-mute">Map unavailable — set MAPBOX_TOKEN</div>
    )
  }

  return (
    <div
      className={`relative h-[calc(100vh-3.5rem)] w-full overflow-hidden${drawActive ? " draw-active" : ""}`}
    >
      {/*
        While drawing, a click belongs to the map, not to whatever pin sits
        under the cursor. This has to be a CSS rule rather than an inline style:
        mapbox sets pointer-events:auto on a marker element after we hand it
        over, and markers are rebuilt whenever the selection changes.
      */}
      <style>{`.draw-active .mapboxgl-marker { pointer-events: none !important; }`}</style>
      {/*
        Inline positioning on purpose: mapbox-gl.css declares
        `.mapboxgl-map { position: relative }` and is loaded after Tailwind, so a
        className of `absolute inset-0` loses once mapbox tags this element and
        the container collapses to zero height.
      */}
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      {/* Scope, draw tool, and the two worklists — top left, over the map */}
      {/*
        pointer-events-none: this container's bounding box spans a wide strip of
        map (and grows tall with the route panel) — only its actual panels may
        catch the pointer, or the map beneath goes dead to pan and zoom.
      */}
      <div className="pointer-events-none absolute left-4 right-[26rem] top-4 z-10 flex flex-col items-start gap-2">
        <div className={`pointer-events-auto w-full px-3 py-2 ${glass}`}>
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <OfficeFilter
                offices={offices}
                value={officeScope}
                onChange={setOfficeScope}
                counts={officeCounts}
                size="sm"
              />
            </div>

            {/* Draw tool and its areas, all on the one row. */}
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              {armed && <span className="text-[11px] text-ink-mute">click to drop the edge</span>}
              {drawing && (
                <span className="text-[11px] text-ink-mute">
                  <span className="font-mono num text-ink">
                    {((spanOf(drawing)?.radiusMi ?? 0) * 2).toFixed(1)}
                  </span>{" "}
                  mi across · click to stop
                </span>
              )}
              <button
                className={`rounded-full border px-3 py-1 text-[11px] font-medium ${
                  armed || drawing
                    ? "border-cyan/40 bg-cyan/15 text-cyan"
                    : "border-line bg-white/[0.03] text-ink-dim hover:border-cyan/40 hover:text-ink"
                }`}
                onClick={() => {
                  setArmed(true)
                  setDrawing(null)
                  setReport(null)
                  if (shapes.length === 0) setExcluded(new Set())
                }}
              >
                {shapes.length > 0 ? "Add area" : "Draw area"}
              </button>
              {shapes.map((span, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full border border-cyan/40 bg-cyan/10 px-2 py-0.5 text-[11px] text-cyan"
                >
                  <span className="font-mono num">
                    {((spanOf(span)?.radiusMi ?? 0) * 2).toFixed(1)}
                  </span>
                  mi
                  <button
                    className="ml-0.5 text-cyan/60 hover:text-cyan"
                    title="remove this area"
                    onClick={() => removeShape(i)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {shapes.length > 1 && (
                <button
                  className="rounded-full border border-line px-2.5 py-1 text-[11px] text-ink-mute hover:text-ink"
                  onClick={clearAll}
                >
                  Clear all
                </button>
              )}
            </div>
          </div>
        </div>

        {changes.length > 0 && (
        <Worklist
          label="unpublished"
          count={changes.length}
          tone="cyan"
          open={list === "changes"}
          onToggle={() => setList(list === "changes" ? null : "changes")}
        >
          {!analysis && changes.length > 0 && (
            <div className="pb-1.5 text-[11px] text-coral">
              cost analysis unavailable — reload the page (details in the console)
            </div>
          )}
          {analysis && (
            <div className="flex items-center gap-3 pb-1.5 text-[11px]">
              <Delta minutes={analysis.netMinutes} suffix=" min/wk" />
              <Delta minutes={analysis.netMi} suffix=" mi/wk" digits={1} />
              <span className="text-ink-mute">
                {Object.entries(analysis.disruption)
                  .map(([k, n]) => `${n} ${k.replace("_", "+")}`)
                  .join(" · ")}
              </span>
            </div>
          )}
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.1em] text-ink-mute">
                <th className="py-1 pr-3 text-left font-medium">Customer</th>
                <th className="py-1 pr-2 text-left font-medium">From</th>
                <th className="py-1" />
                <th className="py-1 pr-2 text-left font-medium">To</th>
                <th className="py-1 pr-2 text-right font-medium">Cost</th>
                <th className="py-1 text-right">
                  <button className="font-medium text-ink-mute hover:text-coral" onClick={revertAll}>
                    clear all
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {changes.map((e, i) => {
                const move = sidesOf(e)
                return (
                  <tr key={i} className="border-t border-line-soft/40">
                    <td className="max-w-[12rem] truncate py-1 pr-3 text-ink-dim">
                      {nameOf(quotaOf(e.quotaId)?.requirement.customerId ?? null)}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-2">
                      {move.from ? (
                        <>
                          <Chip>{move.from.day}</Chip>{" "}
                          {move.from.techId && <Chip>{techOf(move.from.techId)}</Chip>}
                        </>
                      ) : (
                        <span className="text-ink-mute">unplaced</span>
                      )}
                    </td>
                    <td className="px-1 text-center text-ink-mute">&rarr;</td>
                    <td className="whitespace-nowrap py-1 pr-2">
                      {move.to ? (
                        <>
                          <Chip>{move.to.day}</Chip>{" "}
                          {move.to.techId && <Chip>{techOf(move.to.techId)}</Chip>}
                        </>
                      ) : (
                        <span className="text-ink-mute">unplaced</span>
                      )}
                    </td>
                    <td
                      className="whitespace-nowrap py-1 pr-2 text-right"
                      title={
                        analysis
                          ? `legs: −${analysis.moves[i]?.removalGainMi}mi freed, +${analysis.moves[i]?.insertionCostMi}mi paid`
                          : undefined
                      }
                    >
                      {analysis?.moves[i] && (
                        <Delta minutes={analysis.moves[i].exactNetMinutes} suffix="m" digits={1} />
                      )}
                    </td>
                    <td className="py-1 text-right">
                      <button
                        className="px-1 text-ink-mute hover:text-coral"
                        title="undo this change"
                        onClick={() => revertChange(i)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Worklist>
        )}

        {owed > 0 && (
        <Worklist
          label="owed"
          count={owed}
          tone="sun"
          open={list === "owed"}
          onToggle={() => setList(list === "owed" ? null : "owed")}
        >
          {unplaced.map((q) => (
            <div key={q.id} className="flex items-center gap-2 border-b border-line-soft/40 py-1 last:border-0">
              <span className="w-40 truncate text-ink-dim">
                {nameOf(q.requirement.customerId)}
              </span>
              <span className="flex-1 truncate text-ink-mute">
                {officeOf(q.requirement.customerId) ?? "no office"}
              </span>
              <span className="font-mono num text-sun">{q.unmetCount()}</span>
            </div>
          ))}
        </Worklist>
        )}

        {routePanel && (
          <div className={`pointer-events-auto flex max-h-[62vh] w-[21.5rem] flex-col ${glass}`}>
            <div className="flex items-center gap-2.5 px-3.5 pt-3">
              <span
                className="block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: colorOf(routePanel.route.techId) }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-ink">
                  {techOf(routePanel.route.techId)}
                </div>
                <div className="text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                  {WEEKDAY_NAMES[routePanel.route.weekday]} route
                </div>
              </div>
              <button
                className="pl-1 text-[13px] leading-none text-ink-mute hover:text-ink"
                onClick={() => setSelectedRoute(null)}
              >
                ×
              </button>
            </div>

            <RouteLoadBar
              driveMin={routePanel.cost.weeklyDriveMinutes}
              serviceMin={routePanel.cost.weeklyServiceMinutes}
              utilization={routePanel.cost.utilization}
            />

            <div className="mt-2 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3.5 pb-3">
              <div>
                {routePanel.route.base && (
                  <TourStopRow color={colorOf(routePanel.route.techId)} hollow>
                    <div className="flex items-baseline justify-between gap-3 py-1">
                      <span className="text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                        office
                      </span>
                      <span className="shrink-0 font-mono text-[9.5px] text-ink-mute">
                        {routePanel.cost.stops} stops
                      </span>
                    </div>
                  </TourStopRow>
                )}
                {!routePanel.route.base && (
                  <div className="mb-1 flex justify-end font-mono text-[9.5px] text-ink-mute">
                    {routePanel.cost.stops} stops
                  </div>
                )}
                {routePanel.rows.map(({ stop, legIn, legId }, i) => (
                  <Fragment key={`${stop.quotaId}-${i}`}>
                    {legIn && legId && (
                      <TourLegRow
                        leg={legIn}
                        selected={selectedLeg === legId}
                        onClick={() => setSelectedLeg(selectedLeg === legId ? null : legId)}
                      />
                    )}
                    <TourStopRow color={colorOf(routePanel.route.techId)}>
                      <button
                        className={`flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04] ${
                          stop.quotaId === selected ? "bg-cyan/10" : ""
                        }`}
                        onClick={() => setSelected(stop.quotaId === selected ? null : stop.quotaId)}
                      >
                        <span className="w-3.5 shrink-0 text-right font-mono text-[9.5px] text-ink-mute">
                          {i + 1}
                        </span>
                        <span
                          className={`min-w-0 flex-1 truncate text-[11.5px] ${
                            stop.quotaId === selected ? "text-cyan" : "text-ink-dim"
                          }`}
                        >
                          {nameOf(stop.customerId)}
                        </span>
                        <span className="shrink-0 font-mono text-[9.5px] text-ink-mute">
                          {stop.serviceMinutes ?? "~"}m
                        </span>
                      </button>
                    </TourStopRow>
                  </Fragment>
                ))}
                {routePanel.legOut && routePanel.legOutId && (
                  <>
                    <TourLegRow
                      leg={routePanel.legOut}
                      selected={selectedLeg === routePanel.legOutId}
                      onClick={() =>
                        setSelectedLeg(selectedLeg === routePanel.legOutId ? null : routePanel.legOutId)
                      }
                    />
                    <TourStopRow color={colorOf(routePanel.route.techId)} hollow>
                      <div className="py-1 text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                        office
                      </div>
                    </TourStopRow>
                  </>
                )}
                {routePanel.unpinned.map((st) => (
                  <TourStopRow key={st.quotaId} color="#fbbf24" hollow>
                    <div className="py-1 text-[11px] text-sun/90">
                      {nameOf(st.customerId)} - no pin, cannot be sequenced
                    </div>
                  </TourStopRow>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Techs and days — right, over the map */}
      <aside
        className={`absolute right-4 top-4 z-10 flex w-[24rem] flex-col p-3 ${glass} ${
          routesOpen ? "max-h-[calc(100%-2rem)]" : ""
        }`}
      >
        <OptionPills
          multiple
          allLabel="All days"
          size="sm"
          value={dayScope}
          onChange={setDayScope}
          options={WEEKDAY_NAMES.map((n, i) => ({ value: String(i), label: n }))}
        />

        <div className="mt-2.5 flex items-center gap-2 border-t border-line-soft pt-2">
          <button
            className="flex-1 text-left text-[10px] uppercase tracking-[0.14em] text-ink-mute"
            onClick={() => setRoutesOpen((v) => !v)}
          >
            Routes ({visible.length})
          </button>
          {selectedRoute && (
            <button
              className="text-[10px] text-ink-mute hover:text-cyan"
              onClick={() => setSelectedRoute(null)}
            >
              clear
            </button>
          )}
          <button className="text-[11px] text-ink-mute" onClick={() => setRoutesOpen((v) => !v)}>
            {routesOpen ? "−" : "+"}
          </button>
        </div>

        {routesOpen && (
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {byDay.map(({ weekday, routes: dayRoutes }) => (
            <div key={weekday}>
              {byDay.length > 1 && (
                <div className="mt-2.5 text-[10px] font-medium uppercase tracking-[0.12em] text-ink-mute/80 first:mt-0.5">
                  {WEEKDAY_NAMES[weekday]}
                </div>
              )}
              <ul className="mt-0.5">
                {dayRoutes.map(({ route, cost }) => {
                  const key = routeKey(route.techId, route.weekday)
                  const picked = selectedRoute === key
                  return (
                    <li key={key}>
                      <button
                        className={`flex w-full items-center gap-2 rounded-md px-1.5 py-[7px] text-left transition-colors ${
                          picked ? "bg-cyan/10 ring-1 ring-inset ring-cyan/30" : "hover:bg-white/[0.04]"
                        }`}
                        onClick={() => {
                          setSelectedRoute(picked ? null : key)
                          setSelectedLeg(null)
                        }}
                      >
                        <span
                          className="block h-2.5 w-2.5 shrink-0 rounded-full border"
                          style={{
                            background: picked ? colorOf(route.techId) : "transparent",
                            borderColor: colorOf(route.techId),
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
                          {techOf(route.techId)}
                        </span>
                        <UtilDonut
                          driveMin={cost.weeklyDriveMinutes}
                          serviceMin={cost.weeklyServiceMinutes}
                          utilization={cost.utilization}
                        />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
          {visible.length === 0 && (
            <p className="py-2 text-[11px] text-ink-mute">no routes match this scope</p>
          )}
        </div>
        )}
      </aside>

      {/* Selection — bottom left, over the map */}
      {selection !== null && (
        <div className={`absolute bottom-4 left-4 z-10 w-[24rem] p-3 ${glass}`}>
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-ink">
              {selection.length} stop{selection.length === 1 ? "" : "s"} selected
            </span>
            <span className="text-[11px] text-ink-mute">
              {new Set(selection.map((s) => s.quotaId)).size} pools · {shapes.length} area
              {shapes.length === 1 ? "" : "s"}
              {excluded.size > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="text-cyan hover:underline"
                    onClick={() => {
                      setExcluded(new Set())
                      setReport(null)
                    }}
                  >
                    restore {excluded.size} dropped
                  </button>
                </>
              )}
              {dayScope.length > 0 && " · in the days shown"}
            </span>
          </div>

          {selection.length === 0 ? (
            <p className="mt-2 text-[11px] text-ink-mute">
              {excluded.size > 0
                ? "Every matching stop in this area is currently dropped from the selection."
                : `Nothing inside ${shapes.length === 1 ? "that area" : "those areas"}${
                    dayScope.length > 0 ? " on the selected days" : ""
                  }.`}
            </p>
          ) : (
            <>
              <div className="mt-2 max-h-40 overflow-y-auto overflow-x-hidden">
                <table className="w-full table-fixed text-[11px]">
                  <tbody>
                    {selection.map((sel) => {
                      const q = plan.all.find((x) => x.id === sel.quotaId)
                      return (
                        <tr
                          key={`${sel.quotaId}|${sel.techId}|${sel.weekday}`}
                          className="border-b border-line-soft/40 last:border-0"
                        >
                          <td className="truncate py-1 pr-2 text-ink-dim">
                            {nameOf(q?.requirement.customerId ?? null)}
                          </td>
                          <td className="w-12 py-1 pr-2 text-ink-mute">
                            {WEEKDAY_NAMES[sel.weekday]}
                          </td>
                          <td className="w-28 truncate py-1 pr-1 text-ink-mute">
                            {techOf(sel.techId)}
                          </td>
                          <td className="w-5 py-1 text-right">
                            <button
                              className="px-1 text-ink-mute hover:text-coral"
                              title="drop this stop from the selection"
                              onClick={() =>
                                setExcluded((prev) => new Set(prev).add(stopKey(sel)))
                              }
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-2.5 flex items-center gap-1.5">
                <select
                  className="min-w-0 flex-1 rounded border border-line bg-transparent px-1.5 py-1 text-[11px] text-ink"
                  defaultValue=""
                  id="reassign-tech"
                >
                  <option value="">move to tech…</option>
                  {techOptions.map((t) => (
                    <option key={t.id} value={t.id} className="bg-[#0b1620]">
                      {t.name}
                    </option>
                  ))}
                </select>
                <select
                  className="rounded border border-line bg-transparent px-1.5 py-1 text-[11px] text-ink"
                  defaultValue=""
                  id="reassign-day"
                >
                  <option value="">day…</option>
                  {WEEKDAY_NAMES.map((n, i) => (
                    <option key={i} value={i} className="bg-[#0b1620]">
                      {n}
                    </option>
                  ))}
                </select>
                <button
                  className="rounded border border-cyan/40 bg-cyan/15 px-2.5 py-1 text-[11px] font-medium text-cyan"
                  onClick={() => {
                    const t = (document.getElementById("reassign-tech") as HTMLSelectElement)?.value
                    const d = (document.getElementById("reassign-day") as HTMLSelectElement)?.value
                    if (t && d !== "") applyReassign(t, Number(d) as Weekday)
                  }}
                >
                  Move
                </button>
              </div>
            </>
          )}

          {report && (
            <div className="mt-2 border-t border-line-soft pt-2 text-[11px]">
              <span className="text-cyan">{report.moved.length} moved</span>
              {report.skipped.length > 0 && (
                <span className="ml-2 text-ink-mute">
                  {report.skipped.length} skipped ·{" "}
                  {[...new Set(report.skipped.map((s) => s.reason))].join(", ")}
                </span>
              )}
              <div className="mt-1 text-[10px] text-sun">
                In memory only — not written to ION yet.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Selected stop — bottom left, over the map */}
      {selection === null && selectedInfo && (
        <div className={`absolute bottom-4 left-4 z-10 w-[22rem] p-3 ${glass}`}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">
                {nameOf(selectedInfo.quota.requirement.customerId)}
              </div>
              <div className="text-[11px] text-ink-mute">
                {officeOf(selectedInfo.quota.requirement.customerId) ?? "no office"}
                {selectedInfo.route
                  ? ` · ${WEEKDAY_NAMES[selectedInfo.route.weekday]} · ${techOf(selectedInfo.route.techId)}`
                  : ` · ${selectedInfo.quota.unmetCount()} placement owed`}
              </div>
            </div>
            <button
              className="text-[11px] text-ink-mute hover:text-ink"
              onClick={() => setSelected(null)}
            >
              close
            </button>
          </div>

          {selectedInfo.profile && (
            <div className="mt-2 space-y-0.5 text-[11px] text-ink-mute">
              {selectedInfo.profile.runs.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="flex-1">
                    stop {r.position + 1} of {r.runStops}
                  </span>
                  <span className="font-mono num">
                    {r.marginalMi !== null ? `+${r.marginalMi.toFixed(1)}mi` : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Legend — bottom centre */}
      <div
        className={`absolute bottom-4 left-1/2 z-10 -translate-x-1/2 px-3 py-1.5 text-[10px] text-ink-mute ${glass}`}
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full border-2 border-sun" /> placement owed
        </span>
        <span className="ml-3">colour = tech</span>
      </div>
    </div>
  )
}

/** Utilization tone: comfortable, tight, over. */
const utilTone = (u: number) =>
  u <= 0.7 ? "text-emerald-400" : u <= 0.95 ? "text-sun" : "text-coral"

/** A signed cost. Green when the plan gets cheaper, red when it gets dearer. */
function Delta({ minutes, suffix, digits = 0 }: { minutes: number; suffix: string; digits?: number }) {
  const val = digits ? minutes.toFixed(digits) : Math.round(minutes)
  return (
    <span className={`font-mono num ${minutes < 0 ? "text-emerald-400" : minutes > 0 ? "text-coral" : "text-ink-mute"}`}>
      {minutes > 0 ? "+" : ""}
      {val}
      {suffix}
    </span>
  )
}

function RouteLoadBar({
  driveMin,
  serviceMin,
  utilization,
}: {
  driveMin: number
  serviceMin: number
  utilization: number
}) {
  const day = 480
  const total = Math.max(driveMin + serviceMin, day)
  const drivePct = Math.min(100, (driveMin / total) * 100)
  const servicePct = Math.min(100 - drivePct, (serviceMin / total) * 100)
  const headroomPct = Math.max(0, 100 - drivePct - servicePct)

  return (
    <div className="mx-3.5 mt-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[9.5px] uppercase tracking-[0.12em] text-ink-mute">
          utilization
        </span>
        <span className={`font-mono num text-[12px] ${utilTone(utilization)}`}>
          {Math.round(utilization * 100)}%
        </span>
      </div>
      <div className="mt-1.5 flex h-2.5 overflow-hidden rounded-full border border-line-soft bg-white/[0.05]">
        {drivePct > 0 && (
          <span
            className="h-full bg-sky-400"
            style={{ width: `${drivePct}%` }}
            title={`${Math.round(driveMin)}m drive`}
          />
        )}
        {servicePct > 0 && (
          <span
            className="h-full bg-emerald-400"
            style={{ width: `${servicePct}%` }}
            title={`${Math.round(serviceMin)}m service`}
          />
        )}
        {headroomPct > 0 && (
          <span className="h-full bg-white/[0.08]" style={{ width: `${headroomPct}%` }} />
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 font-mono text-[9.5px] text-ink-mute">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
          {Math.round(driveMin)}m drive
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {Math.round(serviceMin)}m service
        </span>
      </div>
    </div>
  )
}

/**
 * The day as a ring: drive arc (sky), service arc (emerald), headroom grey.
 * Over-capacity days fill the whole ring, split proportionally, and the
 * percentage in the middle carries the warning colour.
 */
function UtilDonut({
  driveMin,
  serviceMin,
  utilization,
}: {
  driveMin: number
  serviceMin: number
  utilization: number
}) {
  const day = 480
  const total = Math.max(driveMin + serviceMin, day)
  const r = 15.9155 // circumference 100, so dasharray values are percentages
  const drivePct = (driveMin / total) * 100
  const servicePct = (serviceMin / total) * 100
  const ring = (pct: number, offset: number, color: string) => (
    <circle
      cx="18"
      cy="18"
      r={r}
      fill="none"
      stroke={color}
      strokeWidth="3.4"
      strokeDasharray={`${pct} ${100 - pct}`}
      strokeDashoffset={-offset}
    />
  )
  return (
    <span className="relative block h-9 w-9 shrink-0">
      <svg viewBox="0 0 36 36" className="h-9 w-9 -rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="3.4" />
        {drivePct > 0 && ring(drivePct, 0, "#38bdf8")}
        {servicePct > 0 && ring(servicePct, drivePct, "#34d399")}
      </svg>
      <span
        className={`absolute inset-0 flex items-center justify-center font-mono text-[8.5px] ${utilTone(utilization)}`}
      >
        {Math.round(utilization * 100)}%
      </span>
    </span>
  )
}

type LegMetrics = { minutes: number; miles: number }

/** A stop row owns the stop dot; leg rows own the connecting rail between dots. */
function TourStopRow({
  color,
  hollow = false,
  children,
}: {
  color: string
  hollow?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-center">
      <span className="flex justify-center" aria-hidden="true">
        <TourDot color={color} hollow={hollow} />
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function TourLegRow({
  leg,
  selected,
  onClick,
}: {
  leg: LegMetrics
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="group grid w-full grid-cols-[1.75rem_minmax(0,1fr)] text-left"
      onClick={onClick}
    >
      <span className="relative flex min-h-8 justify-center" aria-hidden="true">
        <span
          className={`h-full w-px transition-colors ${
            selected ? "bg-cyan/90" : "bg-line-soft/80 group-hover:bg-ink-mute/60"
          }`}
        />
      </span>
      <span className="flex min-h-8 items-center">
        <span
          className={`rounded-full border px-2 py-0.5 font-mono text-[9.5px] transition-colors ${
            selected
              ? "border-cyan/50 bg-cyan/15 text-cyan"
              : "border-line-soft/80 bg-[#0E1C2A]/85 text-ink-dim group-hover:border-cyan/25 group-hover:text-ink"
          }`}
        >
          {Math.round(leg.minutes)}m · {leg.miles.toFixed(1)}mi
        </span>
      </span>
    </button>
  )
}

/** Hollow dots mark office anchors; filled dots mark real stops. */
function TourDot({ color, hollow = false }: { color: string; hollow?: boolean }) {
  return (
    <span
      className="block h-2.5 w-2.5 rounded-full border-[1.5px]"
      style={{ background: hollow ? "#0b1620" : color, borderColor: color }}
    />
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full border border-line bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-ink-dim">
      {children}
    </span>
  )
}

/**
 * Where a change moved a stop from and to. A placement has no "from" and a
 * removal has no "to" — both read as unplaced on that side, which is exactly
 * what they mean.
 */
function sidesOf(e: RoutingEvent): {
  from: { day: string; techId: string } | null
  to: { day: string; techId: string } | null
} {
  const at = (p: { techId: string; weekday: number }) => ({
    day: WEEKDAY_NAMES[p.weekday],
    techId: p.techId,
  })
  if (e.kind === "StopMoved") return { from: at(e.from), to: at(e.to) }
  if (e.kind === "StopPlaced") return { from: null, to: at(e.to) }
  if (e.kind === "StopRemoved") return { from: at(e.from), to: null }
  const week = (w: number) => ({ day: `week ${w % 2 === 0 ? "A" : "B"}`, techId: "" })
  return { from: null, to: week(e.toAnchorWeek) }
}

/**
 * A collapsed count that opens downward into its rows. Rendered only when it
 * has something to report, and only as wide as it needs — these sit over the
 * map, so every pixel they take is map you cannot see.
 */
function Worklist({
  label,
  count,
  tone,
  open,
  onToggle,
  children,
}: {
  label: string
  count: number
  tone: "cyan" | "sun"
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const colour = tone === "cyan" ? "text-cyan" : "text-sun"
  return (
    <div className={`pointer-events-auto w-fit max-w-[40rem] ${glass}`}>
      <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left" onClick={onToggle}>
        <span className={`font-mono num text-[13px] ${colour}`}>{count}</span>
        <span className="text-[12px] text-ink-dim">{label}</span>
        <span className="pl-1 text-[11px] text-ink-mute">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="max-h-[60vh] min-w-[17rem] overflow-y-auto overflow-x-hidden border-t border-line-soft px-3 py-1.5 text-[11px]">
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * D4: a route has no office — it reads its stops'. Computed over the whole
 * route, never the filtered subset, or scoping would hide every span.
 */
function officeMixOf(route: Route, officeOf: (id: number | null) => string | null): [string, number][] {
  const mix = new Map<string, number>()
  for (const s of route.stops) {
    const o = officeOf(s.customerId) ?? "no office"
    mix.set(o, (mix.get(o) ?? 0) + 1)
  }
  return [...mix.entries()].sort((a, b) => b[1] - a[1])
}
