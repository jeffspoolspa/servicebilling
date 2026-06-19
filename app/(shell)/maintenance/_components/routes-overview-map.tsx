"use client"

import { useEffect, useRef } from "react"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"

/**
 * All-routes territory overview map: every active maintenance stop on one map,
 * colored by service office, with cross-office outliers (a stop sitting in
 * another office's cluster) ringed in red. Complements the per-route RouteMap —
 * that one colors by per-route geocode flag; this one is about office geography.
 * Token is the existing server-side MAPBOX_TOKEN passed down as a prop.
 */

export interface OverviewStop {
  lat: number
  lng: number
  color: string
  outlier: boolean
  label: string
  sub: string | null
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c)
}

export function RoutesOverviewMap({
  token,
  stops,
  height = 520,
}: {
  token: string | null
  stops: OverviewStop[]
  height?: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!token || !ref.current) return
    mapboxgl.accessToken = token
    const pts = stops.filter(
      (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng),
    )

    const map = new mapboxgl.Map({
      container: ref.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: pts.length ? [pts[0].lng, pts[0].lat] : [-81.4, 31.4],
      zoom: 8,
      attributionControl: false,
    })
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right")

    map.on("load", () => {
      const bounds = new mapboxgl.LngLatBounds()
      // Draw plain stops first, outliers last so their red rings sit on top.
      const ordered = [...pts].sort((a, b) => Number(a.outlier) - Number(b.outlier))
      for (const s of ordered) {
        const el = document.createElement("div")
        el.style.cssText = s.outlier
          ? `width:15px;height:15px;border-radius:50%;background:${s.color};border:2.5px solid #fb7185;box-shadow:0 0 0 3px #fb718577;cursor:pointer`
          : `width:11px;height:11px;border-radius:50%;background:${s.color};border:1.5px solid #0b1620;opacity:0.9;cursor:pointer`
        const popup = new mapboxgl.Popup({ offset: 13, closeButton: false }).setHTML(
          `<div style="font:13px/1.45 system-ui;color:#0b1620"><b>${esc(s.label)}</b>${
            s.sub ? `<br><span style="color:#475569">${esc(s.sub)}</span>` : ""
          }</div>`,
        )
        new mapboxgl.Marker({ element: el }).setLngLat([s.lng, s.lat]).setPopup(popup).addTo(map)
        bounds.extend([s.lng, s.lat])
      }
      if (pts.length === 1) {
        map.setCenter([pts[0].lng, pts[0].lat])
        map.setZoom(12)
      } else if (pts.length > 1) {
        map.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 0 })
      }
    })

    return () => map.remove()
  }, [token, stops])

  if (!token) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-lg border border-line-soft bg-surface text-ink-mute text-[12px]"
      >
        Map unavailable — set MAPBOX_TOKEN
      </div>
    )
  }
  return <div ref={ref} style={{ height }} className="rounded-lg overflow-hidden border border-line-soft" />
}
