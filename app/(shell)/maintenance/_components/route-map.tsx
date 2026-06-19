"use client"

import { useEffect, useRef } from "react"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"

export interface MapStop {
  lat: number | null
  lng: number | null
  label: string
  sub?: string | null
  flag?: string
}

const FLAG_COLOR: Record<string, string> = {
  ok: "#38bdf8",
  far_from_route: "#fbbf24",
  out_of_region: "#fb7185",
  missing: "#fb7185",
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c)
}

/**
 * Interactive Mapbox GL map of a route's stops. Markers are colored by geocode
 * flag (cyan ok, amber far-from-route, coral out-of-region/missing). The token
 * is the existing server-side MAPBOX_TOKEN passed down as a prop (a pk.* token,
 * safe for the browser); when unset the map degrades to a notice.
 */
export function RouteMap({
  token,
  stops,
  height = 380,
}: {
  token: string | null
  stops: MapStop[]
  height?: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!token || !ref.current) return
    mapboxgl.accessToken = token
    const inPts = stops.filter(
      (s): s is MapStop & { lat: number; lng: number } =>
        typeof s.lat === "number" && typeof s.lng === "number" && Number.isFinite(s.lat) && Number.isFinite(s.lng),
    )

    const map = new mapboxgl.Map({
      container: ref.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: inPts.length ? [inPts[0].lng, inPts[0].lat] : [-81.4, 31.2],
      zoom: 9,
      attributionControl: false,
    })
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right")

    map.on("load", () => {
      const bounds = new mapboxgl.LngLatBounds()
      let fitCount = 0
      for (const s of inPts) {
        const color = FLAG_COLOR[s.flag ?? "ok"] ?? FLAG_COLOR.ok
        const el = document.createElement("div")
        el.style.cssText = `width:13px;height:13px;border-radius:50%;background:${color};border:1.5px solid #0b1620;box-shadow:0 0 0 2px ${color}55;cursor:pointer`
        const popup = new mapboxgl.Popup({ offset: 14, closeButton: false }).setHTML(
          `<div style="font:13px/1.4 system-ui;color:#0b1620"><b>${esc(s.label)}</b>${
            s.sub ? `<br><span style="color:#475569">${esc(s.sub)}</span>` : ""
          }</div>`,
        )
        new mapboxgl.Marker({ element: el }).setLngLat([s.lng, s.lat]).setPopup(popup).addTo(map)
        // Only fit to in-region points so one bad out-of-state pin can't zoom the world out.
        if ((s.flag ?? "ok") !== "out_of_region") {
          bounds.extend([s.lng, s.lat])
          fitCount++
        }
      }
      if (fitCount === 1) {
        map.setCenter(bounds.getCenter())
        map.setZoom(13)
      } else if (fitCount > 1) {
        map.fitBounds(bounds, { padding: 44, maxZoom: 14, duration: 0 })
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
