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
import { useRouter } from "next/navigation"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { OptionPills } from "@/components/ui/option-pills"
import { OfficeFilter } from "../_components/office-filter"
import { ScopeMenu } from "../_components/scope-menu"
import { ChangesTable, type ChangeRow } from "./changes-table"
import { TechSelect } from "./tech-select"
import type { Office } from "@/lib/routing/infrastructure/offices"
import {
  baseIdOf,
  cadence,
  cadenceLabel,
  Optimizer,
  Planner,
  type SuggestedMove,
  Circle,
  CostModel,
  DriveMatrix,
  fromSnapshot,
  Route,
  RouteFactory,
  RouteGeometry,
  Scenario,
  WEEKDAY_NAMES,
  type Quota,
  type QuotaSnapshot,
  Pin,
  type ReassignReport,
  type RoutingEvent,
  type SelectedStop,
  type Weekday,
} from "@/lib/routing/domain"
import type { EvaluatedScenario } from "@/lib/routing/application/routing-service"

type Customer = { name: string; office: string | null; commercial: boolean }
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

/**
 * Cadence scope buckets. The four cadences come from the domain's own
 * cadenceLabel (weekly / biweekly A / biweekly B / monthly — the A/B split is
 * anchor-week parity, i.e. WHICH alternating week the pool takes); multi-day
 * is a separate axis, a pool the contract wants on more than one day a week.
 */
const MULTI_DAY = "multi-day"
const CADENCE_BUCKETS = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly A", label: "Bi-weekly A" },
  { value: "biweekly B", label: "Bi-weekly B" },
  { value: "monthly", label: "Monthly" },
]
const cadenceBucketOf = (q: Quota) =>
  cadenceLabel(cadence(q.requirement.intervalWeeks, q.requirement.anchorWeek))

/** One whisper-letter per weekday for inside an 11px dot (Th/Sa/Su need two). */
const DAY_LETTER = ["Su", "M", "Tu", "W", "Th", "F", "Sa"] as const

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

/**
 * Poll queued schedule changes until every one settles.
 *
 * Polling, not Realtime: this runs for the seconds a person stares at a
 * button, and a poll cannot miss an event it was not subscribed for yet.
 * It gives up watching after ~5 minutes — the WORK is unaffected, the drainer
 * owns it now, so a bored watcher costs nothing but a stale chip.
 */
type QueueRow = { id: string; state: string; error: string | null; result_ion_task_id: string | null }

async function watchQueue(ids: string[], say: (s: string) => void): Promise<QueueRow[]> {
  const deadline = Date.now() + 5 * 60_000
  let last: QueueRow[] = []
  for (;;) {
    const r = await fetch(`/api/routing/schedule-changes?ids=${ids.join(",")}`)
    if (r.ok) {
      last = ((await r.json()) as { rows: QueueRow[] }).rows
      const settled = last.filter((x) => x.state === "done" || x.state === "dead_letter")
      if (settled.length === ids.length) return last
      const running = last.find((x) => x.state === "in_flight")
      say(running ? "Writing to ION" : `Waiting for ION — ${settled.length}/${ids.length} settled`)
    }
    if (Date.now() > deadline) return last
    await new Promise((res) => setTimeout(res, 2000))
  }
}

export function LiveMap({
  token,
  week,
  quotas: snapshots,
  offices,
  bases,
  customers,
  techs,
  techOffices,
}: {
  token: string | null
  week: number
  quotas: QuotaSnapshot[]
  offices: Office[]
  /** techId → branch pin: where each tech's day starts and ends. */
  bases: Record<string, { lat: number; lng: number }>
  customers: Record<number, Customer>
  techs: Record<string, string>
  /** techId → office label (the tech's branch), for grouping tech pickers. */
  techOffices: Record<string, string | null>
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
  const [optimalBusy, setOptimalBusy] = useState(false)
  /** The clusters lens: recolour pins by natural geographic cluster. */
  const [clusterLens, setClusterLens] = useState(false)
  /** Bumped when the matrix learns measured legs — estimates must re-derive. */
  const [matrixRev, setMatrixRev] = useState(0)
  const rev = plan.revision
  const routes = useMemo(
    () => plan.routes(factory, week),
    [plan, factory, week, rev, matrixRev],
  )
  const layer = useMemo(() => plan.unplacedLayer(), [plan, rev])
  const changes = useMemo(() => plan.changes(), [plan, rev])

  const [officeScope, setOfficeScope] = useState<string[]>([])
  const [dayScope, setDayScope] = useState<string[]>([])
  /** Res/com and cadence scopes — empty means all, like the office scope. */
  const [typeScope, setTypeScope] = useState<string[]>([])
  const [cadenceScope, setCadenceScope] = useState<string[]>([])
  /** Transient notice (skipped moves etc.) — one per action, self-clearing. */
  const [toast, setToast] = useState<string | null>(null)
  const [publishBusy, setPublishBusy] = useState(false)
  /** Armed = the user pressed Publish and is being asked to confirm in-app. */
  const [publishArmed, setPublishArmed] = useState(false)
  /** What the publish is doing right now, and for how long. Work the user
   *  cannot see is work they assume has failed. */
  const [publishPhase, setPublishPhase] = useState<string | null>(null)
  const [publishSince, setPublishSince] = useState<number | null>(null)
  const [publishElapsed, setPublishElapsed] = useState(0)
  const router = useRouter()
  useEffect(() => {
    if (toast === null) return
    // Long messages are the ones carrying a reason; give them time to be read.
    const t = setTimeout(() => setToast(null), toast.length > 90 ? 14000 : 5000)
    return () => clearTimeout(t)
  }, [toast])

  // A publish takes tens of seconds; the clock is how the user knows it is
  // still working rather than dead.
  useEffect(() => {
    if (publishSince === null) return
    setPublishElapsed(0)
    const t = setInterval(() => setPublishElapsed(Math.round((Date.now() - publishSince) / 1000)), 1000)
    return () => clearInterval(t)
  }, [publishSince])

  // Arming is a question, not a state to be left in.
  useEffect(() => {
    if (!publishArmed) return
    const t = setTimeout(() => setPublishArmed(false), 8000)
    return () => clearTimeout(t)
  }, [publishArmed])

  const [selected, setSelected] = useState<string | null>(null)
  /** Find a customer by name and fly to their pin — the map has ~580 of them. */
  const [pinQuery, setPinQuery] = useState("")
  /** Which customer's task we are re-reading from ION right now. */
  const [refreshingTask, setRefreshingTask] = useState<string | null>(null)
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
  /** Tech picked in the area-reassign and stop-pill panels (searchable pickers). */
  const [reassignTech, setReassignTech] = useState<string | null>(null)
  const [stopPillTech, setStopPillTech] = useState<string | null>(null)
  /** Stops struck off the selection by hand — the shapes still contain them. */
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [list, setList] = useState<"changes" | "owed" | "scenarios" | "suggested" | null>(null)
  const [routesOpen, setRoutesOpen] = useState(true)
  /** Routes panel: flip between route cards and a tech directory; search both. */
  const [routeSearch, setRouteSearch] = useState("")
  const [techFilter, setTechFilter] = useState<Set<string>>(new Set())
  /** Which distinct run of the open route is on view; null = the heaviest. */
  const [runTab, setRunTab] = useState<number | null>(null)
  /** Techs whose route cards are folded away in the panel. */
  const [collapsedTechs, setCollapsedTechs] = useState<Set<string>>(new Set())
  /** Hovered filter → its pins swell on the map. Pure CSS via data attrs; no marker rebuild. */
  const [hoverPins, setHoverPins] = useState<{ attr: "day" | "route" | "tech"; values: string[] } | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestedMove[] | null>(null)
  const [suggestBusy, setSuggestBusy] = useState(false)
  /** The stored scenario being viewed, if any — the plan holds its changes. */
  const [viewing, setViewing] = useState<{ id: string; name: string } | null>(null)
  const [restoreNote, setRestoreNote] = useState<string | null>(null)
  const [pendingScenarios, setPendingScenarios] = useState<EvaluatedScenario[]>([])
  const [saveName, setSaveName] = useState<string | null>(null) // null = input closed
  const [scenarioBusy, setScenarioBusy] = useState(false)
  /**
   * Selected routes (tech|day keys) — ONE set for viewing and optimizing.
   * Clicking rows toggles membership; the map filters to the set; exactly one
   * selected opens the route panel and draws its tour; the Suggest button
   * searches within the set.
   */
  const [selectedRoutes, setSelectedRoutes] = useState<Set<string>>(new Set())
  /** The one route whose tour line and panel are open — a separate, deliberate act. */
  const [tourRoute, setTourRoute] = useState<string | null>(null)
  const selectedRoute = tourRoute
  const setSelectedRoute = (key: string | null) => {
    setTourRoute(key)
    if (key === null) setSelectedRoutes(new Set())
  }
  const toggleRoute = (key: string) =>
    setSelectedRoutes((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
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
    const ids = [...new Set(plan.all.flatMap((q) => q.stops.map((st) => st.techId)))].sort()
    return new Map(ids.map((id, i) => [id, PALETTE[i % PALETTE.length]]))
  }, [plan, rev])
  /** Hand-picked colours over the palette defaults, kept per browser. Loaded
   *  after mount so the server render never disagrees with localStorage. */
  const [techColorOverrides, setTechColorOverrides] = useState<Record<string, string>>({})
  useEffect(() => {
    try {
      const stored = localStorage.getItem("routing-tech-colors")
      if (stored) setTechColorOverrides(JSON.parse(stored))
    } catch {
      /* corrupt store — palette defaults win */
    }
  }, [])
  const setTechColor = (techId: string, color: string) =>
    setTechColorOverrides((prev) => {
      const next = { ...prev, [techId]: color }
      try {
        localStorage.setItem("routing-tech-colors", JSON.stringify(next))
      } catch {
        /* private mode — the colour still holds for this page */
      }
      return next
    })
  const colorOf = (techId: string | null) =>
    (techId && (techColorOverrides[techId] ?? techColor.get(techId))) || NO_TECH_COLOR

  /* ---------------------------------------------------------------- scope */

  const inOffice = (id: number | null) =>
    officeScope.length === 0 || officeScope.includes(officeOf(id) ?? "")
  const inDay = (d: number) => dayScope.length === 0 || dayScope.includes(String(d))
  const inType = (id: number | null) =>
    typeScope.length === 0 ||
    (id !== null && typeScope.includes(customers[id]?.commercial ? "commercial" : "residential"))
  const inCadence = (q: Quota) =>
    cadenceScope.length === 0 ||
    cadenceScope.includes(cadenceBucketOf(q)) ||
    (cadenceScope.includes(MULTI_DAY) && q.requirement.requiredDays > 1)
  /** Customer-level scope (office + res/com) plus the quota's cadence. */
  const inScope = (q: Quota) =>
    inOffice(q.requirement.customerId) && inType(q.requirement.customerId) && inCadence(q)
  const quotaById = useMemo(() => new Map(plan.all.map((q) => [q.id, q])), [plan, rev])

  /** Routes keep only the stops in scope; a route left with none drops out. */
  const visible = useMemo(
    () =>
      routes
        .filter((r) => inDay(r.weekday))
        .map((r) => ({
          route: r,
          stops: r.stops.filter((s) => {
            const q = quotaById.get(s.quotaId)
            return q ? inScope(q) : inOffice(s.customerId)
          }),
        }))
        .filter((v) => v.stops.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routes, dayScope, officeScope, typeScope, cadenceScope, quotaById, customers],
  )

  const unplaced = useMemo(
    () => [...layer.displaced.map((d) => d.quota), ...layer.backlog].filter(inScope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer, officeScope, typeScope, cadenceScope, customers],
  )

  const officeCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const q of plan.all) {
      const o = officeOf(q.requirement.customerId)
      if (o) c[o] = (c[o] ?? 0) + 1
    }
    return c
  }, [plan, customers])

  const typeCounts = useMemo(() => {
    let residential = 0
    let commercial = 0
    for (const q of plan.all) {
      const cid = q.requirement.customerId
      if (cid !== null && customers[cid]?.commercial) commercial++
      else residential++
    }
    return { residential, commercial }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, rev, customers])

  /**
   * Cadence pills. Multi-day is its own bucket that OVERLAPS the others (a
   * 2x-weekly pool is weekly cadence served twice), so the pills read as
   * "show me any of these", same as the office and type scopes.
   */
  const cadenceOptions = useMemo(() => {
    const counts = new Map<string, number>()
    let multiDay = 0
    for (const q of plan.all) {
      const b = cadenceBucketOf(q)
      counts.set(b, (counts.get(b) ?? 0) + 1)
      if (q.requirement.requiredDays > 1) multiDay++
    }
    return [
      { value: MULTI_DAY, label: "Multi-day", count: multiDay },
      ...CADENCE_BUCKETS.filter((b) => counts.has(b.value)).map((b) => ({
        ...b,
        count: counts.get(b.value),
      })),
    ].filter((o) => (o.count ?? 0) > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, rev])

  /**
   * The cost model prices routes for the cards and every pending change for
   * the unpublished box. All domain — the UI only formats.
   */
  const costModel = useMemo(() => new CostModel(geometry, factory), [geometry, factory])

  /** Route cards, day-grouped when more than one day is in scope; heaviest first within a day. */
  /** The tech directory behind the panel's flip view. */
  const techDirectory = useMemo(() => {
    const byTech = new Map<string, { routes: number; stops: number }>()
    for (const v of visible) {
      const t = byTech.get(v.route.techId) ?? { routes: 0, stops: 0 }
      t.routes += 1
      t.stops += v.stops.length
      byTech.set(v.route.techId, t)
    }
    const needle = routeSearch.trim().toLowerCase()
    return [...byTech.entries()]
      .map(([techId, t]) => ({ techId, ...t }))
      .filter((t) => !needle || techOf(t.techId).toLowerCase().includes(needle))
      .sort((a, b) => techOf(a.techId).localeCompare(techOf(b.techId)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, routeSearch, techs])

  /** A selected tech who leaves the directory (day/office filtered out) deselects. */
  useEffect(() => {
    setTechFilter((prev) => {
      if (prev.size === 0) return prev
      const avail = new Set(visible.map((v) => v.route.techId))
      const next = new Set([...prev].filter((id) => avail.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [visible])

  /** The selected techs' routes for the cards panel, grouped per tech, weekday order. */
  const techGroups = useMemo(() => {
    if (techFilter.size === 0) return []
    return [...techFilter]
      .map((id) => ({
        techId: id,
        routes: visible
          .filter((v) => v.route.techId === id)
          .map((v) => ({ route: v.route, cost: costModel.ofRoute(v.route) }))
          .sort((a, b) => a.route.weekday - b.route.weekday),
      }))
      .sort((a, b) => (techs[a.techId] ?? "").localeCompare(techs[b.techId] ?? ""))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, techFilter, costModel, techs])
  const techRoutes = useMemo(() => techGroups.flatMap((g) => g.routes), [techGroups])

  useEffect(() => setRunTab(null), [tourRoute])

  /** A lone card (one day filtered, or a one-route week) fills the panel. */
  useEffect(() => {
    if (techFilter.size > 0 && techRoutes.length === 1) {
      const only = routeKey(techRoutes[0].route.techId, techRoutes[0].route.weekday)
      if (tourRoute !== only) setTourRoute(only)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [techFilter, techRoutes])

  /**
   * Name search over the plan. Matches on the customer name we already show
   * everywhere else, and only offers quotas that HAVE a pin — an unpinned one
   * cannot be flown to, and offering it would be a dead click.
   */
  const pinMatches = useMemo(() => {
    const q = pinQuery.trim().toLowerCase()
    if (q.length < 2) return []
    const out: { quotaId: string; name: string; lat: number; lng: number }[] = []
    for (const quota of plan.all) {
      const pin = quota.requirement.pin
      if (!pin) continue
      const name = nameOf(quota.requirement.customerId)
      if (!name.toLowerCase().includes(q)) continue
      out.push({ quotaId: quota.id, name, lat: pin.lat, lng: pin.lng })
      if (out.length >= 8) break
    }
    return out
  }, [pinQuery, plan.all, customers])

  const flyToPin = (m: { quotaId: string; lat: number; lng: number }) => {
    // Select it as well as centre it: the bottom panel then explains the stop,
    // which is the thing the searcher actually came for.
    setSelected(m.quotaId)
    setPinQuery("")
    mapRef.current?.flyTo({ center: [m.lng, m.lat], zoom: 15, duration: 900 })
  }

  /**
   * Re-read this customer's tasks from ION.
   *
   * The one signal nothing else provides: a schedule changed BY HAND in ION —
   * or a task deleted there — is invisible to us until someone asks. Lucas,
   * 2026-08-05: corrected in ION, still wrong on this map, and no way to say
   * so without the command line.
   */
  const refreshSelectedTask = async (quotaId: string, customerId: number | null) => {
    if (customerId === null) {
      setToast("This pool has no customer link, so ION cannot be asked about it")
      return
    }
    setRefreshingTask(quotaId)
    try {
      const res = await fetch("/api/maintenance/tasks/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId }),
      })
      const out = (await res.json()) as {
        error?: string
        read?: number
        slotsChanged?: number
        skipped?: { taskId: string; reason: string }[]
        drift?: unknown[]
      }
      if (!res.ok) throw new Error(out.error ?? `refresh failed (${res.status})`)
      const changed = out.drift?.length ?? 0
      setToast(
        changed > 0
          ? `Re-read from ION — ${changed} change${changed === 1 ? "" : "s"} found, the map now shows what ION has`
          : out.skipped?.length
            ? `Could not verify: ${out.skipped[0].reason}`
            : "Re-read from ION — already matched",
      )
      // Whatever changed is in the database now, not in the in-memory plan.
      setPlan(Scenario.from(base()))
      router.refresh()
    } catch (err) {
      setToast(`Refresh failed — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRefreshingTask(null)
    }
  }

  const selectedInfo = useMemo(() => {
    if (!selected) return null
    const quota = plan.all.find((q) => q.id === selected)
    if (!quota) return null
    // Every placement's contribution: the marginal miles its route detours for
    // it, converted to drive minutes — its share of the plan's road.
    const placements = quota.stops.map((st) => {
      const route = factory.routeFor(plan.all, st.techId, st.weekday, week)
      const marginalMi = route?.profileOf(selected)?.runs[0]?.marginalMi ?? null
      return {
        stop: st,
        marginalMi,
        driveMinutes: marginalMi !== null ? geometry.driveMinutes(marginalMi) : null,
      }
    })
    return { quota, placements }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, plan, factory, week, rev, matrixRev])

  /**
   * Derived, not stored: re-asking the domain after every edit is what keeps
   * the panel honest once stops start moving.
   */
  const selection = useMemo(() => {
    const regions = shapes.map(spanOf).filter((c): c is Circle => c !== null)
    if (regions.length === 0) return null
    const caught = plan.selectionWithin(regions, dayScope.map((d) => Number(d) as Weekday))
    // The circle grabs what is ON THE MAP, not everything in the geography:
    // office filter, tech filter, and a selected route all scope it.
    const officeOk = (quotaId: string) => {
      const q = plan.all.find((x) => x.id === quotaId)
      return q ? inScope(q) : true
    }
    return {
      stops: caught.stops.filter(
        (s) =>
          !excluded.has(stopKey(s)) &&
          officeOk(s.quotaId) &&
          (techFilter.size === 0 || techFilter.has(s.techId)) &&
          (selectedRoutes.size === 0 || selectedRoutes.has(routeKey(s.techId, s.weekday))),
      ),
      owed: caught.owed.filter((id) => !excluded.has(`owed|${id}`) && officeOk(id)),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, plan, dayScope, rev, excluded, officeScope, typeScope, cadenceScope, techFilter, selectedRoutes, customers])

  const pickedKeys = useMemo(
    () => new Set((selection?.stops ?? []).map(stopKey)),
    [selection],
  )
  const owedPicked = useMemo(() => new Set(selection?.owed ?? []), [selection])

  /** Techs who already hold a route — the plausible targets for a reassignment. */
  const techOptions = useMemo(
    () =>
      [...new Set(routes.map((r) => r.techId))]
        .map((id) => ({ id, name: techOf(id) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [routes, techs],
  )

  /**
   * Natural clusters over whatever the filters show — colour = cluster,
   * hollow grey = a pool that belongs to no cluster (every loner is a detour
   * somebody pays weekly). A lens, not a mode: same pins, different question.
   */
  const clusterView = useMemo(() => {
    if (!clusterLens) return null
    // The office filter scopes the clustering; within the office, members
    // hidden by tech/day/route filters still render (dulled) so a cluster is
    // seen whole.
    const view = new Planner(geometry).clustersOf(plan.all.filter(inScope), 0.5)
    const colour = new Map<string, string>()
    const members = new Map<string, { pin: Pin; techId: string | null }>()
    view.clusters.forEach((c, i) => {
      for (const id of c.quotaIds) {
        colour.set(id, PALETTE[i % PALETTE.length])
        const q = plan.all.find((x) => x.id === id)
        if (q?.requirement.pin) members.set(id, { pin: q.requirement.pin, techId: q.stops[0]?.techId ?? null })
      }
    })
    return { ...view, colour, members }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterLens, plan, rev, officeScope, typeScope, cadenceScope, customers])


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
      map.addSource("clusters", { type: "geojson", data: { type: "FeatureCollection", features: [] } })
      map.addLayer({
        id: "cluster-hull",
        type: "fill",
        source: "clusters",
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.09 },
      })
      map.addLayer({
        id: "cluster-hull-line",
        type: "line",
        source: "clusters",
        paint: {
          "line-color": ["get", "color"],
          "line-width": 1.4,
          "line-opacity": 0.45,
          "line-dasharray": [3, 2],
        },
      })
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
      opts: { ring?: boolean; owed?: boolean; picked?: boolean; dull?: boolean; day?: Weekday; route?: string; tech?: string } = {},
    ) => {
      const el = document.createElement("button")
      el.type = "button"
      el.title = title
      const size = opts.ring ? 17 : opts.picked ? 15 : opts.owed ? 15 : opts.dull ? 8 : 11
      const border = opts.ring
        ? "3px solid #22d3ee"
        : opts.picked
          ? "2.5px solid #f8fafc"
          : opts.owed
            ? "2px solid #fbbf24"
            : "1.5px solid #0b1620"
      el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${color};
        border:${border};cursor:pointer;padding:0;opacity:${opts.picked ? 1 : opts.dull ? 0.35 : 0.92};
        display:grid;place-items:center;line-height:1;
        ${opts.picked ? "box-shadow:0 0 0 3px rgba(248,250,252,.35);z-index:2;" : ""}${opts.ring ? "z-index:3;" : ""}`
      if (opts.day !== undefined && !opts.dull) {
        // A whisper of a day letter inside the dot — size unchanged.
        const ab = DAY_LETTER[opts.day]
        el.innerHTML = `<span style="font:600 ${ab.length > 1 ? 5 : 6.5}px/1 ui-monospace,monospace;
          color:#0b1620;letter-spacing:-0.2px;pointer-events:none">${ab}</span>`
        el.dataset.day = String(opts.day)
      }
      if (opts.route) el.dataset.route = opts.route
      if (opts.tech) el.dataset.tech = opts.tech

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

    // The map narrows with every selection layer: the tech filter shows that
    // tech's whole week, the optimizer scope shows the ticked set, and a
    // single selected route narrows to just it (and opens the panel).
    let pool = visible
    if (techFilter.size > 0) pool = pool.filter((v) => techFilter.has(v.route.techId))
    const matches =
      selectedRoutes.size > 0
        ? pool.filter(
            (v) =>
              selectedRoutes.has(routeKey(v.route.techId, v.route.weekday)) ||
              routeKey(v.route.techId, v.route.weekday) === tourRoute,
          )
        : pool
    // A stale route selection (one that no longer exists in this view) must
    // never blank the map — fall back to the pool. But an EMPTY pool is an
    // honest answer (a tech filtered to a day they don't work): the filter
    // holds and the map goes quiet rather than flashing everyone's pins.
    const shown = matches.length > 0 ? matches : pool

    // Under the lens, cluster members hidden by the current filters still
    // render — dulled — so a cluster is always seen whole.
    if (clusterView) {
      const onScreen = new Set<string>()
      for (const { stops } of shown) for (const st of stops) onScreen.add(st.quotaId)
      for (const q of unplaced) onScreen.add(q.id)
      for (const [quotaId, m] of clusterView.members) {
        if (onScreen.has(quotaId)) continue
        drawn.push({
          rank: -1,
          fn: () =>
            put(m.pin.lat, m.pin.lng, m.techId ? colorOf(m.techId) : "#64748b", quotaId,
              `${nameOf(plan.all.find((x) => x.id === quotaId)?.requirement.customerId ?? null)} — outside current filters`,
              { dull: true }),
        })
      }
    }

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
              {
                ring: s.quotaId === selected,
                picked: pickedKeys.has(`${s.quotaId}|${route.techId}|${route.weekday}`),
                day: route.weekday,
                route: routeKey(route.techId, route.weekday),
                tech: route.techId,
              },
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
  }, [visible, selectedRoute, tourRoute, techFilter, selectedRoutes, unplaced, selected, pickedKeys, colorOf, customers, techs, clusterView])

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

  /** The change list flattened for the data table — display strings only. */
  const changeRows = useMemo<ChangeRow[]>(
    () =>
      changes.map((e, i) => {
        const move = sidesOf(e)
        const cid = quotaOf(e.quotaId)?.requirement.customerId ?? null
        return {
          index: i,
          customer: nameOf(cid),
          office: (cid !== null ? customers[cid]?.office : null) ?? "—",
          fromDay: move.from?.day ?? null,
          fromTech: move.from?.techId ? techOf(move.from.techId) : null,
          toDay: move.to?.day ?? null,
          toTech: move.to?.techId ? techOf(move.to.techId) : null,
          netMinutes: analysis?.moves[i]?.exactNetMinutes ?? null,
          netMi: analysis?.moves[i]?.netMi ?? null,
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [changes, analysis, customers, techs, rev],
  )

  /** The run on view for a route: the tabbed one, else the heaviest. */
  const runOnView = (route: Route) => {
    const runs = route.runs()
    return runTab !== null && runTab < runs.length ? runs[runTab] : route.heaviest()
  }

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
    const run = runOnView(hit.route)
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
  }, [selectedRoute, selectedLeg, visible, token, runTab])

  /**
   * Hydrate the matrix from the permanent leg store (maintenance.drive_legs):
   * a road between two fixed pins never changes, so every leg ever measured
   * prices routes forever — across reloads and sessions. Legs whose stored pin
   * snapshot no longer matches the quota's current pin (re-geocoded pool) are
   * dropped here and simply re-measure on next view.
   */
  const legStoreHydrated = useRef(false)
  useEffect(() => {
    if (legStoreHydrated.current) return
    legStoreHydrated.current = true
    ;(async () => {
      try {
        const res = await fetch("/api/routing/leg-times")
        if (!res.ok) return
        const body = (await res.json()) as {
          legs: {
            from_id: string
            to_id: string
            minutes: number
            miles: number
            from_lat: number
            from_lng: number
            to_lat: number
            to_lng: number
          }[]
        }
        if (!body.legs?.length) return
        const pinOf = new Map<string, Pin>()
        for (const q of plan.all) if (q.requirement.pin) pinOf.set(q.id, q.requirement.pin)
        const close = (a: number, b: number) => Math.abs(a - b) < 1e-5
        const current = (id: string, lat: number, lng: number) => {
          if (id.startsWith("base:")) return true // coords live in the id; a moved office mints a new id
          const pin = pinOf.get(id)
          return pin !== undefined && close(pin.lat, lat) && close(pin.lng, lng)
        }
        const valid = body.legs.filter(
          (l) => current(l.from_id, l.from_lat, l.from_lng) && current(l.to_id, l.to_lat, l.to_lng),
        )
        if (valid.length > 0) {
          geometry.matrix.learn(
            valid.map((l) => ({ fromId: l.from_id, toId: l.to_id, minutes: l.minutes, miles: l.miles })),
          )
          setMatrixRev((n) => n + 1)
        }
      } catch (err) {
        console.warn("leg store hydration failed, estimates stand:", err)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    const run = runOnView(hit.route)
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
  }, [selectedRoute, visible, geometry, runTab])

  /**
   * The selected route, prepared for the panel: cost, and the tour as rows of
   * (stop, leg-in) with office anchors at both ends. Legs price through
   * legRoadBetween, so they show measured minutes the moment the matrix learns.
   */
  const routePanel = useMemo(() => {
    if (!selectedRoute) return null
    const hit = visible.find((v) => routeKey(v.route.techId, v.route.weekday) === selectedRoute)
    if (!hit) return null
    const run = runOnView(hit.route)
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
      run,
      runs: hit.route.runs(),
      unpinned: run.stops.filter((st) => st.pin === null),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoute, visible, costModel, geometry, matrixRev, runTab])

  /* -------------------------------------------------------------- actions */

  const clearAll = () => {
    setArmed(false)
    setShapes([])
    setDrawing(null)
    setReport(null)
    setExcluded(new Set())
    setReassignTech(null)
  }

  const removeShape = (i: number) => {
    setShapes((prev) => prev.filter((_, j) => j !== i))
    setExcluded(new Set())
    setReport(null)
  }

  /** Revert changes by their position in the list — one index or a bulk set. */
  const revertChanges = (indices: number[]) => {
    const drop = new Set(indices)
    setPlan(Scenario.replay(base(), changes.filter((_, i) => !drop.has(i))))
    setReport(null)
  }

  const applyReassign = (techId: string, weekday: Weekday) => {
    if (!selection || (selection.stops.length === 0 && selection.owed.length === 0)) return
    const report = plan.reassign(selection, techId, weekday)
    forceRender((n) => n + 1)
    // Acting on a selection consumes it: the area closes exactly as its ×
    // would. Skips still get said — their panel is gone with the shape.
    clearAll()
    // Valid pools moved; the invalidated ones stay put and get ONE toast for
    // the whole action, not an alert per pool.
    if (report.skipped.length > 0) {
      const reasons = [...new Set(report.skipped.map((x) => x.reason))].join(", ")
      setToast(
        `${report.skipped.length} pool${report.skipped.length === 1 ? "" : "s"} not moved — ${reasons}`,
      )
    }
  }

  /* ----------------------------------------------------- stored scenarios */

  const refreshScenarios = async () => {
    try {
      const res = await fetch("/api/routing/scenarios")
      if (!res.ok) return
      const body = (await res.json()) as { scenarios: EvaluatedScenario[] }
      setPendingScenarios(body.scenarios)
    } catch {
      /* list stays as-is; the card shows what it last knew */
    }
  }
  useEffect(() => {
    void refreshScenarios()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Save the pending changes as a scenario (or update the one being viewed). */
  /**
   * Commit the unpublished changes to ION.
   *
   * Publishing always goes through a scenario, even for ad-hoc edits: the
   * scenario IS the record of what was sent, so saving one first means every
   * published change has a name, a timestamp and a history entry rather than
   * vanishing into ION unattributed. The server closes it out on success.
   */
  const publishToIon = async () => {
    if (publishBusy) return
    if (changes.length === 0) {
      setToast("Nothing to publish — there are no unpublished changes")
      return
    }
    setPublishArmed(false)
    setPublishBusy(true)
    setPublishSince(Date.now())
    setPublishPhase("Recording the scenario")
    try {
      // Make sure there is a scenario to publish and to close out afterwards.
      let scenarioId = viewing?.id ?? null
      if (scenarioId) {
        const patch = await fetch(`/api/routing/scenarios/${scenarioId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes }),
        })
        if (!patch.ok) throw new Error(`could not update the scenario (${patch.status})`)
      } else {
        const made = await fetch("/api/routing/scenarios", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `published ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
            changes,
          }),
        })
        if (!made.ok) throw new Error(`could not record the scenario (${made.status})`)
        scenarioId = ((await made.json()) as { scenario: { id: string } }).scenario.id
      }

      setPublishPhase(
        `Checking ${changes.length} task${changes.length === 1 ? "" : "s"} against ION, then writing`,
      )
      const res = await fetch(`/api/routing/scenarios/${scenarioId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: false }),
      })
      const report = (await res.json()) as {
        error?: string
        committed?: boolean
        results?: { accepted: boolean; detail: string }[]
        invalidated?: { reason: string }[]
        queued?: { taskId: string; queueId: string }[]
      }
      if (!res.ok) throw new Error(report.error ?? `publish failed (${res.status})`)

      // 202: the work is QUEUED, not done. This response is a receipt, not an
      // outcome — so watch the rows. Closing the tab here loses nothing; the
      // drainer finishes regardless, which is why the publish was queued.
      if (res.status === 202 && report.queued?.length) {
        const ids = report.queued.map((q) => q.queueId)
        setPublishPhase(`Queued ${ids.length} change${ids.length === 1 ? "" : "s"} — waiting for ION`)
        // Poke the drain rather than wait out a cron tick. Not awaited: this
        // request runs the whole publish and outlives the click. If it never
        // lands, the schedule picks the row up anyway — that is the point of
        // having queued it, and why this is fire-and-forget rather than a
        // second thing that can fail the button.
        void fetch("/api/routing/schedule-changes/drain", { method: "POST" }).catch(() => {})
        const done = await watchQueue(ids, setPublishPhase)
        const landed = done.filter((r) => r.state === "done")
        const stuck = done.filter((r) => r.state !== "done")
        setToast(
          stuck.length === 0
            ? `Published ${landed.length} task${landed.length === 1 ? "" : "s"} to ION${
                landed[0]?.result_ion_task_id ? ` — new task ${landed[0].result_ion_task_id}` : ""
              }`
            : `${landed.length} landed, ${stuck.length} did not: ${stuck[0].error ?? stuck[0].state}`,
        )
        setPublishPhase("Re-reading the plan")
        setPlan(Scenario.from(base()))
        setViewing(null)
        setRestoreNote(null)
        await refreshScenarios()
        router.refresh()
        return
      }

      const accepted = (report.results ?? []).filter((r) => r.accepted).length
      const refused = (report.results ?? []).length - accepted
      const dropped = report.invalidated ?? []
      // A change that no longer makes sense against the refreshed plan was
      // never sent. Saying "0 published" without saying WHY reads as a failure.
      setToast(
        report.committed
          ? `Published ${accepted} task${accepted === 1 ? "" : "s"} to ION — scenario closed`
          : accepted === 0 && refused === 0 && dropped.length > 0
            ? `Nothing to write — ${dropped.length} change${dropped.length === 1 ? "" : "s"} no longer valid against ION: ${dropped[0].reason}. The map now shows what ION actually has.`
            : `Published ${accepted}, ${refused} refused${dropped.length ? `, ${dropped.length} invalidated` : ""} — scenario left pending. ${
                (report.results ?? []).find((r) => !r.accepted)?.detail ?? dropped[0]?.reason ?? ""
              }`,
      )
      // Our cache was refreshed for whatever landed, so re-read the plan
      // rather than trusting the in-memory scenario.
      setPublishPhase("Re-reading the plan")
      setPlan(Scenario.from(base()))
      setViewing(null)
      setRestoreNote(null)
      await refreshScenarios()
      router.refresh()
    } catch (err) {
      setToast(`Publish failed — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPublishBusy(false)
      setPublishPhase(null)
      setPublishSince(null)
    }
  }

  const saveScenario = async (name: string) => {
    if (changes.length === 0) return
    setScenarioBusy(true)
    try {
      const res = viewing
        ? await fetch(`/api/routing/scenarios/${viewing.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, changes }),
          })
        : await fetch("/api/routing/scenarios", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, changes }),
          })
      if (!res.ok) throw new Error(`save failed (${res.status})`)
      // The changes now live in the scenario — the working plan returns to live.
      setPlan(Scenario.from(base()))
      setViewing(null)
      setRestoreNote(null)
      setSaveName(null)
      setSuggestions(null)
      await refreshScenarios()
    } catch (err) {
      setToast(String(err instanceof Error ? err.message : err))
    } finally {
      setScenarioBusy(false)
    }
  }

  /** Open a stored scenario: replay over the live plan, invalidating stale changes. */
  const openScenario = async (id: string, name: string) => {
    setScenarioBusy(true)
    try {
      const res = await fetch(`/api/routing/scenarios/${id}`)
      if (!res.ok) throw new Error(`load failed (${res.status})`)
      const body = (await res.json()) as { scenario: { changes: RoutingEvent[] } }
      const report = Scenario.restore(base(), body.scenario.changes)
      setPlan(report.scenario)
      setViewing({ id, name })
      setSuggestions(null)
      setRestoreNote(
        report.invalidated.length > 0
          ? `${report.invalidated.length} of ${body.scenario.changes.length} changes invalidated — their stops changed underneath`
          : null,
      )
    } catch (err) {
      setToast(String(err instanceof Error ? err.message : err))
    } finally {
      setScenarioBusy(false)
    }
  }

  const exitScenario = () => {
    setPlan(Scenario.from(base()))
    setViewing(null)
    setRestoreNote(null)
    setSuggestions(null)
  }

  const settleScenario = async (id: string, status: "committed" | "discarded") => {
    setScenarioBusy(true)
    try {
      const res = await fetch(`/api/routing/scenarios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error(`update failed (${res.status})`)
      if (viewing?.id === id) exitScenario()
      await refreshScenarios()
    } catch (err) {
      setToast(String(err instanceof Error ? err.message : err))
    } finally {
      setScenarioBusy(false)
    }
  }

  /** The lens overlay: one soft hull per cluster, pins untouched. */
  useEffect(() => {
    const map = mapRef.current
    const src = map?.getSource("clusters") as mapboxgl.GeoJSONSource | undefined
    if (!src) return
    if (!clusterView) {
      src.setData({ type: "FeatureCollection", features: [] })
      return
    }
    // Convex hull + a small outward buffer. Clusters are chained at 0.5mi, so
    // any two are at least 0.5mi apart at their nearest members — a 0.12mi
    // buffer can never make two hulls overlap.
    const MI_LAT = 1 / 69.0
    const features: GeoJSON.Feature[] = []
    clusterView.clusters.forEach((c, i) => {
      const members = c.quotaIds
        .map((id) => clusterView.members.get(id)?.pin)
        .filter((p): p is Pin => !!p)
      if (members.length === 0) return
      const miLng = MI_LAT / Math.max(Math.cos((c.centre.lat * Math.PI) / 180), 1e-6)
      let ringPts: { lat: number; lng: number }[]
      if (members.length < 3) {
        ringPts = Circle.of(c.centre, Math.max(0.22, ...members.map((p) => c.centre.distanceTo(p)) ) + 0.1).ring(24)
      } else {
        const pts = members.map((p) => ({ x: p.lng, y: p.lat }))
        pts.sort((a, b) => a.x - b.x || a.y - b.y)
        const cross = (o: {x:number;y:number}, a: {x:number;y:number}, b: {x:number;y:number}) =>
          (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
        const lower: typeof pts = []
        for (const pt of pts) {
          while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop()
          lower.push(pt)
        }
        const upper: typeof pts = []
        for (const pt of [...pts].reverse()) {
          while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop()
          upper.push(pt)
        }
        const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)]
        // buffer: push each vertex 0.12mi outward from the centroid
        ringPts = hull.map((v) => {
          const dx = v.x - c.centre.lng
          const dy = v.y - c.centre.lat
          const lenMi = Math.hypot(dx / miLng, dy / MI_LAT) || 1e-6
          const k = (lenMi + 0.12) / lenMi
          return { lat: c.centre.lat + dy * k, lng: c.centre.lng + dx * k }
        })
        ringPts.push(ringPts[0])
      }
      features.push({
        type: "Feature",
        properties: { color: PALETTE[i % PALETTE.length] },
        geometry: { type: "Polygon", coordinates: [ringPts.map((p) => [p.lng, p.lat])] },
      })
    })
    src.setData({ type: "FeatureCollection", features })
  }, [clusterView])

  /* -------------------------------------------------------- optimal draft */

  const enterOptimal = () => {
    setOptimalBusy(true)
    setTimeout(() => {
      try {
        const planner = new Planner(geometry)
        // The draft's inputs are EXACTLY the current view: office filter, tech
        // filter, scoped routes, and the selected day pills. One tech's pools
        // loaded → the draft reworks that tech's week and nothing else.
        // A pool joins the draft only if the view owns EVERY one of its
        // stops — a pool shared with an out-of-scope tech/route stays in
        // place, because reworking it would churn routes nobody asked about.
        const stopInScope = (st: { techId: string; weekday: Weekday }) =>
          (techFilter.size === 0 || techFilter.has(st.techId)) &&
          (selectedRoutes.size === 0 || selectedRoutes.has(routeKey(st.techId, st.weekday))) &&
          (dayScope.length === 0 || dayScope.includes(String(st.weekday)))
        let sharedLeftInPlace = 0
        const scoped = plan.all.filter((q) => {
          if (!inScope(q)) return false
          if (q.stops.length === 0) return techFilter.size === 0 && selectedRoutes.size === 0
          const owned = q.stops.filter(stopInScope).length
          if (owned === 0) return false
          if (owned < q.stops.length) {
            sharedLeftInPlace++
            return false
          }
          return true
        })
        // The slot inventory is the incumbent's: as many routes per day as the
        // scoped view actually runs (Elaina's week = 1 per day, not phantom 2).
        const routesPerDay = new Map<number, Set<string>>()
        for (const q of scoped)
          for (const st of q.stops) {
            const set = routesPerDay.get(st.weekday) ?? new Set()
            set.add(routeKey(st.techId, st.weekday))
            routesPerDay.set(st.weekday, set)
          }
        const maxSlotsPerDay = Math.max(1, ...[...routesPerDay.values()].map((v) => v.size))
        const planBases = offices
          .filter((o) => o.lat !== null && o.lng !== null)
          .filter((o) => officeScope.length === 0 || officeScope.includes(o.label))
          .map((o) => ({ label: o.label, pin: Pin.restore(o.lat!, o.lng!) }))
        // Day slots = the selected day pills; otherwise the days the scoped
        // pools actually run on today.
        const days =
          dayScope.length > 0
            ? dayScope.map((d) => Number(d) as Weekday).sort((a, b) => a - b)
            : [...new Set(scoped.flatMap((q) => q.stops.map((st) => st.weekday)))].sort(
                (a, b) => a - b,
              )
        const world = planner.plan(scoped, planBases, days, { maxSlotsPerDay })
        if (sharedLeftInPlace > 0)
          console.info(`optimal draft: ${sharedLeftInPlace} shared pools left in place (stops outside the scope)`)
        // Straight into the pending set: the draft's diff lands as ordinary
        // unpublished changes — same as hand-moving the pools — so the user
        // saves them as a scenario or reverts them, change by change or all.
        const assignment = planner.assign(scoped, world)
        const all = planner.diff(scoped, world, assignment)
        // A slot nobody overlaps keeps its pseudo id — a staffing signal, not
        // a tech. Moves onto it would seed the plan with fake techs; those
        // pools stay in place and the gap is reported instead.
        const realTech = new Set(scoped.flatMap((q) => q.stops.map((st) => st.techId)))
        for (const id of Object.keys(techs)) realTech.add(id)
        const events = all.filter((e) => !("to" in e) || realTech.has(e.to.techId))
        const needsTech = all.length - events.length
        if (needsTech > 0)
          setToast(`${needsTech} pool${needsTech === 1 ? "" : "s"} would land on a route with no natural tech — left in place (staffing signal)`)
        if (events.length === 0) {
          setToast("the draft matches the current plan — nothing to change")
          return
        }
        let skipped = 0
        for (const e of events) {
          try {
            if (e.kind === "StopPlaced") plan.placeStop(e.quotaId, e.to.techId, e.to.weekday)
            else if (e.kind === "StopMoved") plan.moveStop(e.quotaId, e.from, e.to)
            else if (e.kind === "StopRemoved") plan.unplaceStop(e.quotaId, e.from.techId, e.from.weekday)
          } catch {
            skipped++
          }
        }
        if (skipped > 0) setToast(`${skipped} draft change${skipped === 1 ? "" : "s"} not legal against the current plan — skipped`)
        forceRender((n) => n + 1)
        setList("changes")
      } catch (err) {
        setToast(String(err instanceof Error ? err.message : err))
      } finally {
        setOptimalBusy(false)
      }
    }, 30)
  }

  /* -------------------------------------------------------- the optimizer */

  /**
   * Suggestions follow the view: whatever the filters currently show IS the
   * optimizer's scope — offices, day pills, tech filter, selected routes.
   * Debounced, capped at 20 moves, recomputed as the view or the plan moves.
   */
  useEffect(() => {
    // The scope layers exactly like the map: office and day filters (via
    // `visible`), then the tech filter, then any selected routes.
    let inView = visible
    if (techFilter.size > 0) inView = inView.filter((v) => techFilter.has(v.route.techId))
    if (selectedRoutes.size > 0)
      inView = inView.filter((v) => selectedRoutes.has(routeKey(v.route.techId, v.route.weekday)))
    const scope = inView.map((v) => ({ techId: v.route.techId, weekday: v.route.weekday }))
    if (scope.length < 2) {
      setSuggestions(null)
      return
    }
    setSuggestBusy(true)
    const t = setTimeout(() => {
      try {
        setSuggestions(new Optimizer(geometry, factory).suggest(plan.all, scope, week, 20))
      } finally {
        setSuggestBusy(false)
      }
    }, 450)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, techFilter, selectedRoutes, plan, rev, matrixRev, geometry, factory, week])

  /** Take one suggestion into the pending changes. */
  const addSuggestion = (m: SuggestedMove) => {
    const e = m.event
    if (e.kind !== "StopMoved") return
    try {
      plan.moveStop(e.quotaId, e.from, e.to)
      forceRender((n) => n + 1)
    } catch (err) {
      setToast(String(err instanceof Error ? err.message : err))
    }
    setSuggestions((prev) => prev?.filter((x) => x !== m) ?? null)
  }

  /** Take them all, in the order they were priced. */
  const applyAllSuggestions = () => {
    if (!suggestions) return
    try {
      for (const m of suggestions) {
        const e = m.event
        if (e.kind === "StopMoved") plan.moveStop(e.quotaId, e.from, e.to)
      }
      forceRender((n) => n + 1)
    } catch (err) {
      setToast(String(err instanceof Error ? err.message : err))
    }
    setSuggestions(null)
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
      {hoverPins && (
        <style>{`${hoverPins.values
          .map((v) => `.mapboxgl-marker[data-${hoverPins.attr}="${v.replace(/"/g, "")}"]`)
          .join(",")}{width:17px !important;height:17px !important;z-index:4 !important;
          box-shadow:0 0 0 3px rgba(34,211,238,.45),0 0 10px rgba(34,211,238,.35) !important;}`}</style>
      )}
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
            <div className="flex min-w-0 flex-1 items-center gap-x-3">
              <OfficeFilter
                offices={offices}
                value={officeScope}
                onChange={setOfficeScope}
                counts={officeCounts}
                size="sm"
              />
              <span className="h-4 w-px shrink-0 bg-line-soft" />
              <ScopeMenu
                label="Type"
                value={typeScope}
                onChange={setTypeScope}
                options={[
                  { value: "residential", label: "Residential", count: typeCounts.residential },
                  { value: "commercial", label: "Commercial", count: typeCounts.commercial },
                ]}
              />
              <ScopeMenu
                label="Cadence"
                value={cadenceScope}
                onChange={setCadenceScope}
                options={cadenceOptions}
              />
              {viewing && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-400/10 px-2.5 py-0.5 text-[11px] text-violet-300">
                  viewing scenario &ldquo;{viewing.name}&rdquo;
                  {restoreNote && (
                    <span className="text-sun" title={restoreNote}>
                      · stale
                    </span>
                  )}
                  <button
                    className="ml-0.5 text-violet-300/60 hover:text-violet-300"
                    title="close this scenario (unsaved edits are lost)"
                    onClick={exitScenario}
                  >
                    ×
                  </button>
                </span>
              )}
            </div>

            {/* Draw tool and its areas, all on the one row. */}
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              <button
                className={`rounded-full border px-3 py-1 text-[11px] font-medium ${
                  clusterLens
                    ? "border-violet-400/50 bg-violet-400/15 text-violet-300"
                    : "border-line bg-white/[0.03] text-ink-dim hover:border-violet-400/40 hover:text-violet-300"
                }`}
                title="colour pins by natural geographic cluster; grey = belongs to no cluster"
                onClick={() => setClusterLens((v) => !v)}
              >
                Clusters
              </button>
              <button
                className="rounded-full border border-line bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-ink-dim hover:border-emerald-500/40 hover:text-emerald-400 disabled:opacity-50"
                disabled={optimalBusy}
                title="draft the scoped pools from scratch and offer the diff as picks — filters stay put"
                onClick={enterOptimal}
              >
                {optimalBusy ? "drafting…" : "Optimal"}
              </button>
              {armed && <span className="text-[11px] text-ink-mute">click to drop the edge</span>}
              {drawing && (
                <span className="text-[11px] text-ink-mute">
                  <span className="font-mono num text-ink">
                    {((spanOf(drawing)?.radiusMi ?? 0) * 2).toFixed(1)}
                  </span>{" "}
                  mi across · click to stop
                </span>
              )}
              {/* Find a pin — in the toolbar with the other map-wide actions,
                  not floating over the map where it covered the scenario chips. */}
              <div className="relative">
                <input
                  value={pinQuery}
                  onChange={(e) => setPinQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setPinQuery("")
                    if (e.key === "Enter" && pinMatches.length > 0) flyToPin(pinMatches[0])
                  }}
                  placeholder="Find a customer…"
                  className="w-44 rounded-full border border-line bg-white/[0.03] px-3 py-1 text-[11px] text-ink placeholder:text-ink-mute outline-none focus:border-cyan/40"
                />
                {pinQuery.trim().length >= 2 && (
                  <div className={`absolute left-0 top-8 z-20 max-h-64 w-60 overflow-y-auto px-1 py-1 ${glass}`}>
                    {pinMatches.length === 0 ? (
                      <div className="px-2 py-1 text-[11px] text-ink-mute">no pinned customer matches</div>
                    ) : (
                      pinMatches.map((m) => (
                        <button
                          key={m.quotaId}
                          onClick={() => flyToPin(m)}
                          className="block w-full truncate rounded px-2 py-1 text-left text-[11.5px] text-ink-dim hover:bg-white/[0.05] hover:text-ink"
                        >
                          {m.name}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
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
          wide
          open={list === "changes"}
          onToggle={() => setList(list === "changes" ? null : "changes")}
        >
          {!analysis && changes.length > 0 && (
            <div className="pb-1.5 text-[11px] text-coral">
              cost analysis unavailable — reload the page (details in the console)
            </div>
          )}
          {/* Remount on every plan revision: rows are index-keyed, so a
              revert must never meet yesterday's selection. */}
          <ChangesTable
            key={rev}
            rows={changeRows}
            onRevert={revertChanges}
            headerExtra={
              <>
                {publishArmed && !publishBusy ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      className="shrink-0 rounded-full border border-emerald-500/60 bg-emerald-500/25 px-2.5 py-0.5 text-[10.5px] font-medium text-emerald-200 hover:bg-emerald-500/35"
                      title={`writes ${changes.length} change${changes.length === 1 ? "" : "s"} to the live ION schedule — each task is rewritten with its complete week, so unchanged days are preserved`}
                      onClick={() => void publishToIon()}
                    >
                      {`Confirm — write ${changes.length} to ION`}
                    </button>
                    <button
                      className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10.5px] text-dim hover:text-ink"
                      onClick={() => setPublishArmed(false)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[10.5px] font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                    title="write these changes to ION — each task is rewritten with its complete week"
                    disabled={publishBusy || scenarioBusy}
                    onClick={() => setPublishArmed(true)}
                  >
                    {publishBusy ? `Publishing… ${publishElapsed}s` : "Publish to ION"}
                  </button>
                )}
                {saveName === null ? (
                <button
                  className="shrink-0 rounded-full border border-violet-400/40 bg-violet-400/10 px-2.5 py-0.5 text-[10.5px] font-medium text-violet-300 hover:bg-violet-400/20 disabled:opacity-50"
                  disabled={scenarioBusy}
                  onClick={() => setSaveName(viewing?.name ?? "")}
                >
                  {viewing ? "Save scenario" : "Save as scenario"}
                </button>
              ) : (
                <span className="flex shrink-0 items-center gap-1">
                  <input
                    autoFocus
                    className="w-36 rounded border border-line bg-transparent px-1.5 py-0.5 text-[11px] text-ink outline-none focus:border-violet-400/60"
                    placeholder="scenario name…"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && saveName.trim()) void saveScenario(saveName.trim())
                      if (e.key === "Escape") setSaveName(null)
                    }}
                  />
                  <button
                    className="rounded border border-violet-400/40 bg-violet-400/15 px-2 py-0.5 text-[10.5px] font-medium text-violet-300 disabled:opacity-50"
                    disabled={!saveName.trim() || scenarioBusy}
                    onClick={() => void saveScenario(saveName.trim())}
                  >
                    save
                  </button>
                  <button
                    className="px-1 text-[11px] text-ink-mute hover:text-ink"
                    onClick={() => setSaveName(null)}
                  >
                    ×
                  </button>
                </span>
                )}
              </>
            }
          />
        </Worklist>
        )}

        {pendingScenarios.length > 0 && (
        <Worklist
          label={`pending scenario${pendingScenarios.length === 1 ? "" : "s"}`}
          count={pendingScenarios.length}
          tone="cyan"
          open={list === "scenarios"}
          onToggle={() => setList(list === "scenarios" ? null : "scenarios")}
        >
          {pendingScenarios.map((sc) => (
            <div
              key={sc.id}
              className={`flex items-center gap-2 border-b border-line-soft/40 py-1.5 last:border-0 ${
                viewing?.id === sc.id ? "text-violet-300" : ""
              }`}
            >
              <button
                className="w-40 truncate text-left font-medium text-ink-dim hover:text-violet-300"
                title="open this scenario"
                onClick={() => void openScenario(sc.id, sc.name)}
              >
                {sc.name}
              </button>
              <span className="w-24 shrink-0 text-right">
                <Delta minutes={sc.netMinutes} suffix=" min/wk" />
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-mute">
                {sc.appliedCount} change{sc.appliedCount === 1 ? "" : "s"}
                {sc.invalidCount > 0 && (
                  <span className="text-sun"> · {sc.invalidCount} stale</span>
                )}
              </span>
              <button
                className="shrink-0 rounded border border-emerald-500/40 px-1.5 py-0.5 text-[10px] text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50"
                disabled={scenarioBusy}
                title="mark committed — the ION write-back runs when the publisher lands"
                onClick={() => void settleScenario(sc.id, "committed")}
              >
                commit
              </button>
              <button
                className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-mute hover:text-coral disabled:opacity-50"
                disabled={scenarioBusy}
                onClick={() => void settleScenario(sc.id, "discarded")}
              >
                discard
              </button>
            </div>
          ))}
        </Worklist>
        )}

        {(suggestBusy || (suggestions?.length ?? 0) > 0) && (
        <Worklist
          label={suggestBusy ? "suggesting…" : "suggested changes"}
          count={suggestions?.length ?? 0}
          tone="emerald"
          open={list === "suggested"}
          onToggle={() => setList(list === "suggested" ? null : "suggested")}
        >
          <div className="flex items-center gap-2 pb-1.5">
            <span className="text-[10.5px] text-ink-mute">
              scoped to the current filters · priced in order
            </span>
            <span className="flex-1" />
            {(suggestions?.length ?? 0) > 0 && (
              <button
                className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[10.5px] font-medium text-emerald-400 hover:bg-emerald-500/20"
                onClick={applyAllSuggestions}
              >
                Apply all ·{" "}
                {Math.round((suggestions ?? []).reduce((n, m) => n + m.exactNetMinutes, 0))} min/wk
              </button>
            )}
          </div>
          {(suggestions ?? []).slice(0, 20).map((m, i) => {
            const e = m.event
            if (e.kind !== "StopMoved") return null
            return (
              <div
                key={i}
                className="flex items-center gap-1.5 border-t border-line-soft/40 py-1.5 text-[11px] first:border-0"
              >
                <span className="w-36 truncate text-ink-dim">{nameOf(m.customerId)}</span>
                <Chip>{WEEKDAY_NAMES[e.from.weekday]}</Chip>
                <Chip>{techOf(e.from.techId)}</Chip>
                <span className="text-ink-mute">&rarr;</span>
                <Chip>{WEEKDAY_NAMES[e.to.weekday]}</Chip>
                <Chip>{techOf(e.to.techId)}</Chip>
                <span className="flex-1" />
                <Delta minutes={m.exactNetMinutes} suffix="m" digits={1} />
                <button
                  className="rounded border border-emerald-500/40 px-1.5 py-0.5 text-[10px] text-emerald-400 hover:bg-emerald-500/10"
                  title="add to pending changes"
                  onClick={() => addSuggestion(m)}
                >
                  +
                </button>
              </div>
            )
          })}
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

        {techFilter.size > 0 && (
          <div className={`pointer-events-auto flex max-h-[74vh] w-[22.5rem] flex-col ${glass}`}>
            <div className="flex items-center gap-2.5 px-3.5 pt-3">
              <span className="flex shrink-0 -space-x-1">
                {techGroups.map((g) => (
                  <span
                    key={g.techId}
                    className="block h-2.5 w-2.5 rounded-full ring-1 ring-[#0b1620]"
                    style={{ background: colorOf(g.techId) }}
                  />
                ))}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-ink">
                  {techGroups.length === 1
                    ? techOf(techGroups[0].techId)
                    : `${techGroups.length} techs`}
                </div>
                <div className="text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                  {techRoutes.length} route{techRoutes.length === 1 ? "" : "s"} this week
                </div>
              </div>
              <button
                className="pl-1 text-[13px] leading-none text-ink-mute hover:text-ink"
                onClick={() => {
                  setTechFilter(new Set())
                  setTourRoute(null)
                }}
              >
                ×
              </button>
            </div>


            <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto overflow-x-hidden px-3.5 pb-3">
              {techGroups.map((g) => {
                const folded = collapsedTechs.has(g.techId)
                return (
                <div key={g.techId} className="space-y-1.5">
                  {techGroups.length > 1 && (
                    <button
                      className="flex w-full items-center gap-1.5 pt-1 text-left"
                      onClick={() =>
                        setCollapsedTechs((prev) => {
                          const next = new Set(prev)
                          if (next.has(g.techId)) next.delete(g.techId)
                          else next.add(g.techId)
                          return next
                        })
                      }
                      onMouseEnter={() => setHoverPins({ attr: "tech", values: [g.techId] })}
                      onMouseLeave={() => setHoverPins(null)}
                    >
                      <span
                        className="block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: colorOf(g.techId) }}
                      />
                      <span className="truncate text-[11px] font-semibold text-ink-dim">
                        {techOf(g.techId)}
                      </span>
                      <span className="text-[10px] text-ink-mute">
                        {g.routes.length} route{g.routes.length === 1 ? "" : "s"}
                      </span>
                      <span className="flex-1" />
                      <span className="text-[11px] text-ink-mute">{folded ? "+" : "−"}</span>
                    </button>
                  )}
                  {!folded && g.routes.map(({ route, cost }) => {
                const key = routeKey(route.techId, route.weekday)
                const open = tourRoute === key
                return (
                  <div
                    key={key}
                    className={`rounded-lg border ${
                      open ? "border-cyan/40 bg-cyan/[0.06]" : "border-line-soft bg-white/[0.02]"
                    }`}
                  >
                    <button
                      className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left"
                      onClick={() => {
                        setTourRoute(open ? null : key)
                        setSelectedLeg(null)
                      }}
                      onMouseEnter={() => setHoverPins({ attr: "route", values: [key] })}
                      onMouseLeave={() => setHoverPins(null)}
                    >
                      <span className="w-9 shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
                        {WEEKDAY_NAMES[route.weekday]}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink-mute">
                        {cost.stops} stops ·{" "}
                        <span className="font-mono num">{Math.round(cost.weeklyDriveMinutes)}m</span>{" "}
                        drive ·{" "}
                        <span className="font-mono num">{Math.round(cost.weeklyServiceMinutes)}m</span>{" "}
                        service
                      </span>
                      <UtilDonut
                        driveMin={cost.weeklyDriveMinutes}
                        serviceMin={cost.weeklyServiceMinutes}
                        utilization={cost.utilization}
                      />
                    </button>

                    {open && routePanel && (
                      <div className="border-t border-line-soft px-2.5 pb-2.5">
                        {routePanel.runs.length > 1 && (
                          <div className="mt-1.5 flex items-center gap-1">
                            <span className="pr-1 text-[9.5px] uppercase tracking-[0.12em] text-ink-mute">
                              runs
                            </span>
                            {routePanel.runs.map((r, i) => {
                              const active = routePanel.run === r
                              return (
                                <button
                                  key={i}
                                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                                    active
                                      ? "border-cyan/40 bg-cyan/15 text-cyan"
                                      : "border-line bg-white/[0.03] text-ink-mute hover:text-ink"
                                  }`}
                                  title={`fires weeks ${r.weeks.join(", ")}`}
                                  onClick={() => setRunTab(i)}
                                >
                                  {String.fromCharCode(65 + i)} · {r.stops.length}
                                </button>
                              )
                            })}
                          </div>
                        )}
                        <div className="-mx-1">
                          <RouteLoadBar
                            driveMin={routePanel.run.estimate.driveMinutes}
                            serviceMin={routePanel.run.estimate.serviceMinutes}
                            utilization={routePanel.run.estimate.utilization}
                          />
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5">
                          <TechSelect
                            className="min-w-0 flex-1"
                            placeholder="hand this route to another tech…"
                            techs={Object.entries(techs)
                              .filter(([id, name]) => id !== route.techId && name.trim())
                              .map(([id, name]) => ({ id, name }))}
                            officeOf={(id) => techOffices[id] ?? null}
                            onSelect={(toTechId) => {
                              try {
                                plan.reassignRouteTech(route.techId, route.weekday, toTechId)
                                setTechFilter(new Set([toTechId]))
                                setTourRoute(routeKey(toTechId, route.weekday))
                                forceRender((n) => n + 1)
                              } catch (err) {
                                setToast(String(err instanceof Error ? err.message : err))
                              }
                            }}
                          />
                        </div>

                        <div className="mt-2 max-h-[40vh] overflow-y-auto overflow-x-hidden">
                          <div>
                            {routePanel.route.base && (
                              <TourStopRow color={colorOf(route.techId)} hollow>
                                <div className="flex items-baseline justify-between gap-3 py-1">
                                  <span className="text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                                    office
                                  </span>
                                </div>
                              </TourStopRow>
                            )}
                            {routePanel.rows.map(({ stop, legIn, legId }, i) => (
                              <Fragment key={`${stop.quotaId}-${i}`}>
                                {legIn && legId && (
                                  <TourLegRow
                                    leg={legIn}
                                    selected={selectedLeg === legId}
                                    onClick={() =>
                                      setSelectedLeg(selectedLeg === legId ? null : legId)
                                    }
                                  />
                                )}
                                <TourStopRow color={colorOf(route.techId)}>
                                  <button
                                    className={`-mx-1 flex w-[calc(100%+8px)] items-baseline gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-white/[0.04] ${
                                      stop.quotaId === selected ? "bg-cyan/10" : ""
                                    }`}
                                    onClick={() =>
                                      setSelected(stop.quotaId === selected ? null : stop.quotaId)
                                    }
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
                                      <span
                                        className={`ml-1.5 rounded border px-1 font-mono text-[8.5px] ${
                                          stop.intervalWeeks > 1
                                            ? "border-sun/40 text-sun"
                                            : "border-line text-ink-mute"
                                        }`}
                                      >
                                        {stop.intervalWeeks}w
                                      </span>
                                    </span>
                                    <span className="shrink-0 font-mono text-[9.5px] text-ink-mute">
                                      {stop.serviceMinutes ?? "~"}m
                                    </span>
                                    <span
                                      role="button"
                                      className="shrink-0 px-1 text-[11px] leading-none text-ink-mute hover:text-coral"
                                      title="unassign — the pool becomes owed until re-placed"
                                      onClick={(ev) => {
                                        ev.stopPropagation()
                                        try {
                                          plan.unplaceStop(stop.quotaId, route.techId, route.weekday)
                                          forceRender((n) => n + 1)
                                        } catch (err) {
                                          setToast(String(err instanceof Error ? err.message : err))
                                        }
                                      }}
                                    >
                                      ×
                                    </span>
                                  </button>
                                </TourStopRow>
                              </Fragment>
                            ))}
                            {routePanel.legOut && (
                              <>
                                <TourLegRow
                                  leg={routePanel.legOut}
                                  selected={selectedLeg === routePanel.legOutId}
                                  onClick={() =>
                                    setSelectedLeg(
                                      selectedLeg === routePanel.legOutId ? null : routePanel.legOutId,
                                    )
                                  }
                                />
                                <TourStopRow color={colorOf(route.techId)} hollow>
                                  <div className="py-1 text-[10px] uppercase tracking-[0.12em] text-ink-mute">
                                    office
                                  </div>
                                </TourStopRow>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
                </div>
                )
              })}
              {techRoutes.length === 0 && (
                <p className="py-2 text-[11px] text-ink-mute">no routes on the selected days</p>
              )}
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
        <div
          onMouseOver={(e) => {
            const label = (e.target as HTMLElement).closest("button")?.textContent?.trim()
            const i = WEEKDAY_NAMES.indexOf(label as (typeof WEEKDAY_NAMES)[number])
            setHoverPins(i >= 0 ? { attr: "day", values: [String(i)] } : null)
          }}
          onMouseLeave={() => setHoverPins(null)}
        >
          <OptionPills
            multiple
            allLabel="All days"
            size="sm"
            value={dayScope}
            onChange={setDayScope}
            options={WEEKDAY_NAMES.map((n, i) => ({ value: String(i), label: n }))}
          />
        </div>
        <div className="mt-2 flex items-center gap-2.5">
          <button
            className="flex-1 text-left text-[10px] uppercase tracking-[0.14em] text-ink-mute"
            onClick={() => setRoutesOpen((v) => !v)}
          >
            Techs ({techDirectory.length})
          </button>
          {techFilter.size > 0 && (
            <button
              className="text-[10px] text-ink-mute hover:text-cyan"
              onClick={() => {
                setTechFilter(new Set())
                setTourRoute(null)
              }}
            >
              clear
            </button>
          )}
          <button className="text-[11px] text-ink-mute" onClick={() => setRoutesOpen((v) => !v)}>
            {routesOpen ? "−" : "+"}
          </button>
        </div>
        {routesOpen && (
          <>
            <input
              className="mt-2 min-w-0 rounded border border-line bg-white/[0.02] px-2 py-1 text-[11px] text-ink placeholder:text-ink-mute/60 outline-none focus:border-cyan/40"
              placeholder="search techs…"
              value={routeSearch}
              onChange={(e) => setRouteSearch(e.target.value)}
            />
            <div className="mt-1 min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
              <ul className="mt-0.5">
                {techDirectory.map((t) => {
                  const picked = techFilter.has(t.techId)
                  return (
                    <li key={t.techId}>
                      <div
                        className={`flex w-full items-center gap-2 rounded-md px-1.5 py-[7px] transition-colors ${
                          picked ? "bg-cyan/10 ring-1 ring-inset ring-cyan/30" : "hover:bg-white/[0.04]"
                        }`}
                        onMouseEnter={() => setHoverPins({ attr: "tech", values: [t.techId] })}
                        onMouseLeave={() => setHoverPins(null)}
                      >
                        {/* The dot IS the colour picker — the OS wheel opens on click. */}
                        <input
                          type="color"
                          className="tech-dot h-2.5 w-2.5 shrink-0"
                          value={colorOf(t.techId)}
                          title="change this tech's colour"
                          onChange={(e) => setTechColor(t.techId, e.target.value)}
                        />
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => {
                            setTechFilter((prev) => {
                              const next = new Set(prev)
                              if (next.has(t.techId)) next.delete(t.techId)
                              else next.add(t.techId)
                              return next
                            })
                            setTourRoute(null)
                            setSelectedRoutes(new Set())
                            setSelected(null)
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
                            {techOf(t.techId)}
                          </span>
                          <span className="font-mono num text-[10.5px] text-ink-mute">
                            {t.routes} route{t.routes === 1 ? "" : "s"} · {t.stops}
                          </span>
                        </button>
                      </div>
                    </li>
                  )
                })}
                {techDirectory.length === 0 && (
                  <p className="py-2 text-[11px] text-ink-mute">no techs match</p>
                )}
              </ul>
            </div>
          </>
        )}
      </aside>

      {/* Selection — bottom left, over the map */}
      {selection !== null && (
        <div className={`absolute bottom-4 left-4 z-10 w-[24rem] p-3 ${glass}`}>
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-ink">
              {selection.stops.length} stop{selection.stops.length === 1 ? "" : "s"}
              {selection.owed.length > 0 && (
                <span className="text-sun"> + {selection.owed.length} owed</span>
              )}{" "}
              selected
            </span>
            <span className="text-[11px] text-ink-mute">
              {new Set(selection.stops.map((s) => s.quotaId)).size} pools · {shapes.length} area
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

          {selection.stops.length === 0 && selection.owed.length === 0 ? (
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
                    {selection.owed.map((quotaId) => {
                      const q = plan.all.find((x) => x.id === quotaId)
                      return (
                        <tr key={`owed-${quotaId}`} className="border-b border-line-soft/40 last:border-0">
                          <td className="truncate py-1 pr-2 text-ink-dim">
                            {nameOf(q?.requirement.customerId ?? null)}
                          </td>
                          <td className="w-12 py-1 pr-2 text-sun">owed</td>
                          <td className="w-28 truncate py-1 pr-1 text-ink-mute">unplaced</td>
                          <td className="w-5 py-1 text-right">
                            <button
                              className="px-1 text-ink-mute hover:text-coral"
                              title="drop this owed quota from the selection"
                              onClick={() => setExcluded((prev) => new Set(prev).add(`owed|${quotaId}`))}
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                    {selection.stops.map((sel) => {
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
                <TechSelect
                  className="min-w-0 flex-1"
                  placeholder="move to tech…"
                  techs={techOptions}
                  officeOf={(id) => techOffices[id] ?? null}
                  value={reassignTech}
                  onSelect={setReassignTech}
                  direction="up"
                />
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
                    const d = (document.getElementById("reassign-day") as HTMLSelectElement)?.value
                    if (reassignTech && d !== "") applyReassign(reassignTech, Number(d) as Weekday)
                  }}
                >
                  Move
                </button>
                <button
                  className="rounded border border-line px-2.5 py-1 text-[11px] text-ink-mute hover:border-sun/40 hover:text-sun"
                  title="every selected stop becomes owed until re-placed"
                  onClick={() => {
                    if (!selection) return
                    for (const st of selection.stops) {
                      try {
                        plan.unplaceStop(st.quotaId, st.techId, st.weekday)
                      } catch {
                        /* already gone — the selection was stale for this one */
                      }
                    }
                    forceRender((n) => n + 1)
                    clearAll()
                  }}
                >
                  Unassign
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

      {/* Running work is always visible: what it is doing, and for how long.
          This one does NOT self-clear — it ends when the work does. */}
      {publishPhase && (
        <div
          className={`absolute bottom-32 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2.5 border-emerald-400/40 px-3.5 py-2 text-[12px] text-emerald-200 ${glass}`}
        >
          <span className="h-3 w-3 animate-spin rounded-full border border-emerald-300/40 border-t-emerald-200" />
          <span>{publishPhase}</span>
          <span className="tabular-nums text-emerald-300/70">{publishElapsed}s</span>
        </div>
      )}

      {/* Transient notice — one line, self-clearing */}
      {toast && (
        <div
          className={`absolute bottom-20 left-1/2 z-30 max-w-[36rem] -translate-x-1/2 border-sun/40 px-3.5 py-2 text-[12px] text-sun ${glass}`}
        >
          {toast}
        </div>
      )}

      {/* Bottom centre: the selected stop when there is one, the legend when not */}
      {selectedInfo ? (
        <div
          className={`absolute bottom-4 left-1/2 z-10 flex max-w-[44rem] -translate-x-1/2 items-center gap-3 px-3.5 py-2 ${glass}`}
        >
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="max-w-[13rem] truncate text-[12.5px] font-semibold text-ink">
                {nameOf(selectedInfo.quota.requirement.customerId)}
              </span>
              <span className="text-[10px] text-ink-mute">
                {cadenceLabel(
                  cadence(
                    selectedInfo.quota.requirement.intervalWeeks,
                    selectedInfo.quota.requirement.anchorWeek,
                  ),
                )}
                {" · "}
                {selectedInfo.quota.requirement.serviceMinutes ?? "~22"}m on site
                {" · "}
                {officeOf(selectedInfo.quota.requirement.customerId) ?? "no office"}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {selectedInfo.placements.map((p) => (
                <span
                  key={`${p.stop.techId}|${p.stop.weekday}`}
                  className="inline-flex items-center gap-1 rounded-full border border-line bg-white/[0.04] px-2 py-0.5 text-[10px] text-ink-dim"
                >
                  {WEEKDAY_NAMES[p.stop.weekday]} · {techOf(p.stop.techId)}
                  {p.driveMinutes !== null && (
                    <span className="font-mono text-ink-mute">
                      +{Math.round(p.driveMinutes)}m drive
                    </span>
                  )}
                  <button
                    className="pl-0.5 text-[11px] leading-none text-ink-mute hover:text-coral"
                    title="unassign — the pool becomes owed until re-placed"
                    onClick={() => {
                      try {
                        plan.unplaceStop(selectedInfo.quota.id, p.stop.techId, p.stop.weekday)
                        forceRender((n) => n + 1)
                      } catch (err) {
                        setToast(String(err instanceof Error ? err.message : err))
                      }
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
              {selectedInfo.quota.unmetCount() > 0 && (
                <span className="rounded-full border border-sun/50 bg-sun/10 px-2 py-0.5 text-[10px] text-sun">
                  {selectedInfo.quota.unmetCount()} owed
                </span>
              )}
            </div>
          </div>

          {/* Re-read from ION. Sits with the pool's own facts, not the move
              controls: it changes what is TRUE, not what is planned. */}
          <button
            className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-ink-dim hover:border-cyan/40 hover:text-cyan disabled:opacity-50"
            disabled={refreshingTask === selectedInfo.quota.id}
            title="re-read this customer's tasks from ION — catches edits and deletions made there"
            onClick={() =>
              refreshSelectedTask(
                selectedInfo.quota.id,
                selectedInfo.quota.requirement.customerId,
              )
            }
          >
            {refreshingTask === selectedInfo.quota.id ? "reading…" : "Refresh"}
          </button>

          {/* Move: the first placement (or an owed slot) to a new tech-day. */}
          <div className="flex shrink-0 items-center gap-1.5 border-l border-line-soft pl-3">
            <TechSelect
              className="w-36"
              placeholder="tech…"
              techs={Object.entries(techs)
                .filter(([, name]) => name.trim())
                .map(([id, name]) => ({ id, name }))}
              officeOf={(id) => techOffices[id] ?? null}
              value={stopPillTech}
              onSelect={setStopPillTech}
              direction="up"
            />
            <select
              id="stop-pill-day"
              className="rounded border border-line bg-transparent px-1.5 py-1 text-[10.5px] text-ink"
              defaultValue=""
            >
              <option value="">day…</option>
              {WEEKDAY_NAMES.map((n, i) => (
                <option key={i} value={i} className="bg-[#0b1620]">
                  {n}
                </option>
              ))}
            </select>
            <button
              className="rounded border border-cyan/40 bg-cyan/15 px-2 py-1 text-[10.5px] font-medium text-cyan"
              onClick={() => {
                const t = stopPillTech
                const d = (document.getElementById("stop-pill-day") as HTMLSelectElement)?.value
                if (!selectedInfo) return
                if (!t || d === "") {
                  setToast(`Pick a ${!t ? "tech" : "day"} before moving this stop`)
                  return
                }
                try {
                  const first = selectedInfo.placements[0]
                  if (selectedInfo.quota.unmetCount() > 0 && !first) {
                    plan.placeStop(selectedInfo.quota.id, t, Number(d) as Weekday)
                  } else if (first) {
                    plan.moveStop(
                      selectedInfo.quota.id,
                      { techId: first.stop.techId, weekday: first.stop.weekday },
                      { techId: t, weekday: Number(d) as Weekday },
                    )
                  }
                  forceRender((n) => n + 1)
                } catch (err) {
                  setToast(String(err instanceof Error ? err.message : err))
                }
              }}
            >
              Move
            </button>
            <button
              className="pl-1 text-[12px] text-ink-mute hover:text-ink"
              onClick={() => setSelected(null)}
            >
              ×
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`absolute bottom-4 left-1/2 z-10 -translate-x-1/2 px-3 py-1.5 text-[10px] text-ink-mute ${glass}`}
        >
          {clusterView ? (
            <>
              <span>
                colour = cluster ·{" "}
                <span className="font-mono num text-ink-dim">{clusterView.clusters.length}</span>{" "}
                clusters
              </span>
              <span className="ml-3 inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#475569" }} />
                <span className="font-mono num text-ink-dim">{clusterView.loners.length}</span> in no
                cluster
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full border-2 border-sun" /> placement owed
              </span>
              <span className="ml-3">colour = tech</span>
            </>
          )}
        </div>
      )}
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
  wide = false,
  open,
  onToggle,
  children,
}: {
  label: string
  count: number
  tone: "cyan" | "sun" | "emerald"
  /** Room for a full data table rather than a compact list. */
  wide?: boolean
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const colour =
    tone === "cyan" ? "text-cyan" : tone === "sun" ? "text-sun" : "text-emerald-400"
  // Wide + open fills the worklist strip (up to 56rem) so a data table inside
  // scales with the viewport; collapsed it shrinks back to a chip.
  const width = wide && open ? "w-full max-w-[56rem]" : "w-fit max-w-[40rem]"
  return (
    <div className={`pointer-events-auto ${width} ${glass}`}>
      <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left" onClick={onToggle}>
        <span className={`font-mono num text-[13px] ${colour}`}>{count}</span>
        <span className="text-[12px] text-ink-dim">{label}</span>
        <span className="pl-1 text-[11px] text-ink-mute">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div
          className={`min-w-[17rem] overflow-y-auto overflow-x-hidden border-t border-line-soft px-3 py-1.5 text-[11px] ${
            wide ? "max-h-[calc(100vh-9rem)]" : "max-h-[60vh]"
          }`}
        >
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
