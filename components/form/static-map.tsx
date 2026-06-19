"use client"

import { useState } from "react"
import { cn } from "@/lib/utils/cn"

/**
 * Small map viewer for an address. Points at /api/places/staticmap, which renders
 * via Mapbox Static Images server-side (token never reaches the browser). Renders
 * nothing if the address is empty or the image fails (token unset / not found),
 * so it degrades gracefully. Clicking opens the location in a maps search.
 */
export function StaticMap({
  address,
  lat,
  lng,
  className,
  height = 140,
}: {
  address: string
  lat?: number | null
  lng?: number | null
  className?: string
  height?: number
}) {
  const [failed, setFailed] = useState(false)
  const hasCoords = lat != null && lng != null
  if ((!address.trim() && !hasCoords) || failed) return null

  const params = new URLSearchParams()
  if (hasCoords) {
    params.set("lat", String(lat))
    params.set("lng", String(lng))
  } else {
    params.set("q", address)
  }
  params.set("h", String(Math.min(height, 320)))
  const src = `/api/places/staticmap?${params.toString()}`
  const href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("block overflow-hidden rounded-lg border border-line", className)}
      title={address}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={address ? `Map showing ${address}` : "Map"}
        className="w-full object-cover"
        style={{ height }}
        onError={() => setFailed(true)}
      />
    </a>
  )
}
