"use client"

import { useEffect, useRef } from "react"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"

/**
 * Route Planner map view. Every active, rooftop-confirmed stop is a teardrop pin:
 * fill = tech color, head glyph = day, solid black outline. Focusing a set of
 * pins (hovering a day in the legend, or selecting a route) scales them up a
 * touch and SLIGHTLY BLURS the rest — one shared "focus" treatment. Hovering a
 * pin shows a customer/address card; selecting a route also animates a
 * "navigation" line drawn through that route's stops in visit order.
 *
 * Reuses the dark-v11 mapbox style + server-side MAPBOX_TOKEN like the other
 * maintenance maps.
 */

export interface PlannerMapStop {
  /** route key = `${tech_employee_id}|${day_of_week}` */
  routeKey: string
  lat: number
  lng: number
  /** pin fill = tech color */
  color: string
  /** day-of-week glyph shown in the pin head (e.g. "Mo") */
  glyph: string
  /** contrast color for the glyph on top of `color` */
  glyphColor: string
  /** pin outline color */
  stroke: string
  label: string
  sub: string | null
}

// Teardrop map-pin, inset inside the viewBox (overflow visible as backstop) so the
// constant-width outline never clips the edge. Only the stroke color varies, so
// the silhouette is always identical.
const PIN_W = 28
const PIN_H = 38
const PIN_STROKE_W = 2
const PIN_PATH =
  "M14 1.5 C8.2 1.5 3.5 6.2 3.5 12 C3.5 19.5 14 37 14 37 C14 37 24.5 19.5 24.5 12 C24.5 6.2 19.8 1.5 14 1.5 Z"
function pinSVG(fill: string, glyph: string, glyphTextColor: string, stroke: string): string {
  return (
    `<svg width="${PIN_W}" height="${PIN_H}" viewBox="0 0 28 38" style="overflow:visible" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="${PIN_PATH}" fill="${fill}" stroke="${stroke}" stroke-width="${PIN_STROKE_W}" stroke-linejoin="round"/>` +
    `<text x="14" y="12" text-anchor="middle" dominant-baseline="central" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11" font-weight="700" fill="${glyphTextColor}">${glyph}</text>` +
    `</svg>`
  )
}

// Marker filters (applied to the INNER wrapper).
const SHADOW_DEFAULT = "drop-shadow(0 1px 1.5px rgba(0,0,0,0.55))"
const SHADOW_FOCUS = "drop-shadow(0 3px 5px rgba(0,0,0,0.55))"
const BLUR_BG = "blur(1.5px) drop-shadow(0 1px 1px rgba(0,0,0,0.4))"
const FOCUS_SCALE = "1.32"

const LINE_SOURCE = "route-line"
const EMPTY_LINE = { type: "FeatureCollection" as const, features: [] }
function lineFeature(coords: [number, number][]) {
  return {
    type: "FeatureCollection" as const,
    features: [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: coords } }],
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c)
}
function cardHTML(label: string, sub: string | null): string {
  return (
    `<div class="pin-card-body"><div class="pin-card-title">${esc(label)}</div>` +
    (sub ? `<div class="pin-card-sub">${esc(sub)}</div>` : "") +
    `</div>`
  )
}

export function RoutePlannerMap({
  token,
  stops,
  selectedKey,
  hoverKeys,
  routeLine,
  routeLineColor,
  onSelectRoute,
  height,
}: {
  token: string | null
  stops: PlannerMapStop[]
  selectedKey: string | null
  /** Route keys to focus (hovering a day in the legend); blurs the rest. */
  hoverKeys: Set<string> | null
  /** Ordered [lng,lat] of the selected route's stops, for the nav line. */
  routeLine: [number, number][] | null
  /** Nav line color (the selected route's tech color). */
  routeLineColor: string | null
  onSelectRoute: (routeKey: string) => void
  height?: number | string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<
    Array<{ key: string; el: HTMLDivElement; inner: HTMLDivElement; marker: mapboxgl.Marker }>
  >([])
  const onSelectRef = useRef(onSelectRoute)
  onSelectRef.current = onSelectRoute

  // Build the map + markers once per token/stops change.
  useEffect(() => {
    if (!token || !ref.current) return
    mapboxgl.accessToken = token
    const pts = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))

    const map = new mapboxgl.Map({
      container: ref.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: pts.length ? [pts[0].lng, pts[0].lat] : [-81.4, 31.4],
      zoom: 8,
      attributionControl: false,
    })
    mapRef.current = map
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-right")

    // One shared hover card (no tip; dark via .pin-card CSS).
    const hoverPopup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 30,
      className: "pin-card",
    })

    const addMarkers = () => {
      const bounds = new mapboxgl.LngLatBounds()
      const made: typeof markersRef.current = []
      for (const s of pts) {
        // Mapbox owns the ROOT element's transform; OUR state goes on an inner wrapper.
        const el = document.createElement("div")
        el.dataset.routeKey = s.routeKey
        el.style.cssText = `width:${PIN_W}px;height:${PIN_H}px;cursor:pointer`
        const inner = document.createElement("div")
        inner.style.cssText = `width:100%;height:100%;transform-origin:50% 100%;opacity:0.95;transition:transform 150ms,opacity 150ms,filter 150ms;filter:${SHADOW_DEFAULT}`
        inner.innerHTML = pinSVG(s.color, s.glyph, s.glyphColor, s.stroke)
        el.appendChild(inner)
        el.addEventListener("click", (e) => {
          e.stopPropagation()
          onSelectRef.current(s.routeKey)
        })
        // hover the pin → customer/address card (not tied to click)
        el.addEventListener("mouseenter", () => {
          hoverPopup.setLngLat([s.lng, s.lat]).setHTML(cardHTML(s.label, s.sub)).addTo(map)
        })
        el.addEventListener("mouseleave", () => hoverPopup.remove())
        const marker = new mapboxgl.Marker({ element: el, anchor: "bottom" }).setLngLat([s.lng, s.lat]).addTo(map)
        made.push({ key: s.routeKey, el, inner, marker })
        bounds.extend([s.lng, s.lat])
      }
      markersRef.current = made
      if (pts.length === 1) {
        map.setCenter([pts[0].lng, pts[0].lat])
        map.setZoom(12)
      } else if (pts.length > 1) {
        map.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 0 })
      }
      restyle(selectedKeyRef.current, hoverKeysRef.current)
    }

    addMarkers()
    requestAnimationFrame(() => {
      try {
        map.resize()
      } catch {
        /* map may be torn down by a StrictMode remount before this runs */
      }
    })
    // Draw the line for any pre-existing selection once the map settles. ('idle'
    // is reliable here; 'load' can stall when the flex container starts 0-width.)
    map.once("idle", () => drawRouteLine(routeLineRef.current, lineColorRef.current))

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      hoverPopup.remove()
      map.remove()
      mapRef.current = null
      markersRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, stops])

  // Track latest selection / hover / line so effects + load handler can read them.
  const selectedKeyRef = useRef(selectedKey)
  selectedKeyRef.current = selectedKey
  const hoverKeysRef = useRef(hoverKeys)
  hoverKeysRef.current = hoverKeys
  const routeLineRef = useRef(routeLine)
  routeLineRef.current = routeLine
  const lineColorRef = useRef(routeLineColor)
  lineColorRef.current = routeLineColor
  const rafRef = useRef<number | null>(null)

  // ONE focus treatment for both hover (a day) and selection (a route): focused
  // pins scale up + lift; the rest get a slight blur. Scale/opacity/filter on the
  // inner wrapper, z on the root. (Mapbox owns the root transform.)
  function restyle(sel: string | null, hover: Set<string> | null) {
    const hovering = !!hover && hover.size > 0
    const focusing = hovering || sel != null
    for (const m of markersRef.current) {
      const focused = hovering ? hover!.has(m.key) : sel != null && m.key === sel
      if (!focusing) {
        m.inner.style.transform = "scale(1)"
        m.inner.style.opacity = "0.95"
        m.inner.style.filter = SHADOW_DEFAULT
        m.el.style.zIndex = "1"
      } else if (focused) {
        m.inner.style.transform = `scale(${FOCUS_SCALE})`
        m.inner.style.opacity = "1"
        m.inner.style.filter = SHADOW_FOCUS
        m.el.style.zIndex = "11"
      } else {
        m.inner.style.transform = "scale(1)"
        m.inner.style.opacity = "0.85"
        m.inner.style.filter = BLUR_BG
        m.el.style.zIndex = "1"
      }
    }
  }

  // Lazily create the line source+layer. The 'load'/style-loaded signals are
  // unreliable on this map (0-width-container stall), but addLayer works once the
  // style is parsed — so we try here and bail if too early (a later call retries).
  function ensureLineLayer(map: mapboxgl.Map): boolean {
    if (map.getLayer(LINE_SOURCE)) return true
    try {
      if (!map.getSource(LINE_SOURCE)) map.addSource(LINE_SOURCE, { type: "geojson", data: EMPTY_LINE })
      map.addLayer({
        id: LINE_SOURCE,
        type: "line",
        source: LINE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#38bdf8", "line-width": 3.5, "line-opacity": 0.9 },
      })
      return true
    } catch {
      return false // style not parsed yet; a later draw retries
    }
  }

  // Progressive "draw" of the nav line through the route's stops (in order).
  function drawRouteLine(coords: [number, number][] | null, color: string | null) {
    const map = mapRef.current
    if (!map || !ensureLineLayer(map)) return // not ready; a later call retries
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (color) map.setPaintProperty(LINE_SOURCE, "line-color", color)
    const src = map.getSource(LINE_SOURCE) as mapboxgl.GeoJSONSource
    if (!coords || coords.length < 2) {
      src.setData(EMPTY_LINE)
      return
    }
    const seg: number[] = []
    let total = 0
    for (let i = 1; i < coords.length; i++) {
      const dx = coords[i][0] - coords[i - 1][0]
      const dy = coords[i][1] - coords[i - 1][1]
      const d = Math.hypot(dx, dy)
      seg.push(d)
      total += d
    }
    if (total === 0) {
      src.setData(lineFeature(coords))
      return
    }
    const ease = (t: number) => 1 - Math.pow(1 - t, 3) // easeOutCubic
    const duration = 650
    let startTs: number | null = null
    const frame = (ts: number) => {
      if (startTs == null) startTs = ts
      const t = Math.min(1, (ts - startTs) / duration)
      const target = ease(t) * total
      const partial: [number, number][] = [coords[0]]
      let acc = 0
      for (let i = 1; i < coords.length; i++) {
        if (acc + seg[i - 1] <= target) {
          partial.push(coords[i])
          acc += seg[i - 1]
        } else {
          const r = seg[i - 1] ? (target - acc) / seg[i - 1] : 0
          partial.push([
            coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * r,
            coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * r,
          ])
          break
        }
      }
      src.setData(lineFeature(partial))
      if (t < 1) rafRef.current = requestAnimationFrame(frame)
      else rafRef.current = null
    }
    rafRef.current = requestAnimationFrame(frame)
  }

  // Re-style + zoom whenever the selection changes (no full remount).
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    restyle(selectedKey, hoverKeysRef.current)
    if (!selectedKey) return
    const selPts = markersRef.current.filter((m) => m.key === selectedKey)
    if (selPts.length === 0) return
    const bounds = new mapboxgl.LngLatBounds()
    for (const m of selPts) bounds.extend(m.marker.getLngLat())
    if (selPts.length === 1) {
      map.easeTo({ center: selPts[0].marker.getLngLat(), zoom: 12, duration: 400 })
    } else {
      map.fitBounds(bounds, { padding: 90, maxZoom: 13, duration: 400 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  // Re-style (no zoom) whenever the hover focus changes.
  useEffect(() => {
    if (!mapRef.current) return
    restyle(selectedKeyRef.current, hoverKeys)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverKeys])

  // Animate the nav line whenever the selected route's path changes.
  useEffect(() => {
    drawRouteLine(routeLine, routeLineColor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeLine, routeLineColor])

  if (!token) {
    return (
      <div
        style={{ height: height ?? "100%" }}
        className="flex items-center justify-center rounded-lg border border-line-soft bg-surface text-ink-mute text-[12px]"
      >
        Map unavailable — set MAPBOX_TOKEN
      </div>
    )
  }
  return <div ref={ref} style={{ height: height ?? "100%", width: "100%" }} className="overflow-hidden" />
}
