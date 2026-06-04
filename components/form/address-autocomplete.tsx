"use client"

import { useEffect, useRef, useState } from "react"

/**
 * Google Places address autocomplete (mirrors the public website).
 *
 * Renders one search input; on a place pick it parses the address components and
 * calls onPicked({ street, city, state, zip, county }). The parent form still owns
 * the editable street/city/state/zip fields (pre-filled from onPicked), so:
 *   - with NEXT_PUBLIC_GOOGLE_MAPS_API_KEY set → type + pick a suggestion.
 *   - without the key → this renders a hint and the parent's manual fields are used.
 *
 * Loader pattern ported from perfectpools-redesign GetStartedQuote.tsx.
 */

export interface PickedAddress {
  street: string
  city: string
  state: string
  zip: string
  county: string
  formatted: string
}

const KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare global { interface Window { google?: any; __gmapsLoading?: Promise<void> } }

function loadGoogleMaps(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  if (window.google?.maps?.places) return Promise.resolve()
  if (window.__gmapsLoading) return window.__gmapsLoading
  window.__gmapsLoading = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script")
    s.src = `https://maps.googleapis.com/maps/api/js?key=${KEY}&libraries=places&loading=async`
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error("Google Maps failed to load"))
    document.head.appendChild(s)
  })
  return window.__gmapsLoading
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(place: any): PickedAddress {
  const get = (type: string, short = false) =>
    (place.address_components ?? []).find((c: { types: string[] }) => c.types.includes(type))?.[short ? "short_name" : "long_name"] ?? ""
  const streetNo = get("street_number")
  const route = get("route")
  return {
    street: [streetNo, route].filter(Boolean).join(" "),
    city: get("locality") || get("sublocality") || get("postal_town"),
    state: get("administrative_area_level_1", true) || "GA",
    zip: get("postal_code"),
    county: get("administrative_area_level_2").replace(/ County$/i, ""),
    formatted: place.formatted_address ?? "",
  }
}

export function AddressAutocomplete({
  onPicked,
  className = "",
  placeholder = "Start typing the service address…",
}: {
  onPicked: (a: PickedAddress) => void
  className?: string
  placeholder?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!KEY || !inputRef.current) return
    let ac: { addListener: (e: string, cb: () => void) => void } | null = null
    loadGoogleMaps()
      .then(() => {
        if (!inputRef.current) return
        ac = new window.google.maps.places.Autocomplete(inputRef.current, {
          componentRestrictions: { country: "us" },
          types: ["address"],
          fields: ["address_components", "geometry", "formatted_address"],
        })
        ac!.addListener("place_changed", () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const place = (ac as any).getPlace()
          if (place?.address_components) onPicked(parse(place))
        })
        setReady(true)
      })
      .catch(() => setReady(false))
  }, [onPicked])

  if (!KEY) {
    return (
      <p className="text-[12px] text-ink-mute">
        Address autocomplete is off (set <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code>). Enter the address below.
      </p>
    )
  }

  return (
    <input
      ref={inputRef}
      type="text"
      autoComplete="off"
      placeholder={ready ? placeholder : "Loading address search…"}
      className={className}
      disabled={!ready}
    />
  )
}
