"use client"

import { useEffect, useRef } from "react"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"

/**
 * Interactive Mapbox GL map with a single pin at a service address (ADR 005). Pan/zoom/
 * navigation controls so you can look around the pin. Token is the server-side pk.*
 * MAPBOX_TOKEN passed down as a prop; degrades to a notice when unset.
 */
export function AddressMap({
  token,
  lat,
  lng,
  height = 200,
}: {
  token: string | null
  lat: number
  lng: number
  height?: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!token || !ref.current) return
    mapboxgl.accessToken = token
    const map = new mapboxgl.Map({
      container: ref.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [lng, lat],
      zoom: 15,
      attributionControl: false,
    })
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right")
    const el = document.createElement("div")
    el.style.cssText =
      "width:15px;height:15px;border-radius:50%;background:#38bdf8;border:2px solid #0b1620;box-shadow:0 0 0 3px #38bdf855"
    new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map)
    return () => map.remove()
  }, [token, lat, lng])

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
