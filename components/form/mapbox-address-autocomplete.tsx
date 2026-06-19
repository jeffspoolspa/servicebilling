"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { MapPin } from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * Address autocomplete backed by Google Places (ADR 005). /api/places/autocomplete returns
 * predictions (id=place_id, label); on pick we fetch /api/places/details for the canonical,
 * place_id-derived address + coordinate, then onPicked({ id, street, city, state, zip, lat,
 * lng, label }). The dropdown renders in a PORTAL with fixed positioning so it's never clipped
 * by an ancestor's overflow (table / card). (Named MapboxAddressAutocomplete for now —
 * provider is Google.)
 */

export interface PickedAddress {
  id: string // google place_id
  street: string
  city: string
  state: string
  zip: string
  lat: number | null
  lng: number | null
  label: string
}

interface Prediction {
  id: string
  label: string
}

export function MapboxAddressAutocomplete({
  onPicked,
  className = "",
  placeholder = "Start typing an address…",
  autoFocus = false,
}: {
  onPicked: (a: PickedAddress) => void
  className?: string
  placeholder?: string
  /** Focus the input on mount (e.g. when a button reveals it) so you can type right away. */
  autoFocus?: boolean
}) {
  const [q, setQ] = useState("")
  const [suggestions, setSuggestions] = useState<Prediction[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipNext = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const session = useRef<string>("")
  if (!session.current && typeof crypto !== "undefined" && crypto.randomUUID) {
    session.current = crypto.randomUUID()
  }

  // Focus on mount when revealed by a button, so you can start typing immediately.
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function measure() {
    const r = inputRef.current?.getBoundingClientRect()
    if (r) setRect({ top: r.bottom + 4, left: r.left, width: r.width })
  }

  useEffect(() => {
    if (skipNext.current) {
      skipNext.current = false
      return
    }
    if (q.trim().length < 3) {
      setSuggestions([])
      setOpen(false)
      return
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setLoading(true)
      try {
        const r = await fetch(
          `/api/places/autocomplete?q=${encodeURIComponent(q)}&session=${session.current}`,
        )
        const data = await r.json()
        setSuggestions(data.suggestions ?? [])
        measure()
        setOpen(true)
      } catch {
        setSuggestions([])
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [q])

  // Keep the portal dropdown glued to the input while open (scroll / resize).
  useEffect(() => {
    if (!open) return
    measure()
    const h = () => measure()
    window.addEventListener("scroll", h, true)
    window.addEventListener("resize", h)
    return () => {
      window.removeEventListener("scroll", h, true)
      window.removeEventListener("resize", h)
    }
  }, [open])

  async function pick(s: Prediction) {
    setOpen(false)
    setSuggestions([])
    setLoading(true)
    try {
      const r = await fetch(
        `/api/places/details?place_id=${encodeURIComponent(s.id)}&session=${session.current}`,
      )
      const data = await r.json()
      if (data.address) {
        const a = data.address
        onPicked({
          id: a.place_id,
          street: a.street,
          city: a.city,
          state: a.state,
          zip: a.zip,
          lat: a.lat,
          lng: a.lng,
          label: a.label,
        })
        skipNext.current = true
        setQ(a.label)
        if (typeof crypto !== "undefined" && crypto.randomUUID) session.current = crypto.randomUUID()
      }
    } catch {
      /* leave the field as typed */
    } finally {
      setLoading(false)
    }
  }

  const dropdown =
    open && (suggestions.length > 0 || loading) && rect && typeof document !== "undefined"
      ? createPortal(
          <div
            style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width, zIndex: 9999 }}
            className="max-h-72 overflow-auto rounded-md border border-line bg-bg-elev shadow-card"
          >
            {loading && suggestions.length === 0 && (
              <div className="px-3 py-2 text-[13px] text-ink-mute">Searching…</div>
            )}
            {suggestions.map((s) => (
              <button
                key={s.id || s.label}
                type="button"
                onMouseDown={() => pick(s)}
                className="flex w-full items-start gap-2 px-3 py-2 text-left text-[13px] text-ink-dim hover:bg-white/5 hover:text-ink transition-colors"
              >
                <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-mute" />
                <span className="min-w-0">{s.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )
      : null

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => {
          if (suggestions.length > 0) {
            measure()
            setOpen(true)
          }
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className={cn(className)}
      />
      {dropdown}
    </div>
  )
}
