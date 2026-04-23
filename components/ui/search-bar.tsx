"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Search, X } from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * URL-driven search input for paginated tables.
 *
 * Keeps state in a `?q=...` search param so the value survives reloads,
 * shareable URLs, and browser back/forward. Debounced ~300ms to avoid
 * firing a server fetch on every keystroke. Hitting Enter commits
 * immediately, Esc clears.
 *
 * Page param is reset to 1 on every search change — otherwise you'd end
 * up on page 3 of a filtered result set that only has one page.
 *
 * Client component because it owns the input + debounce; the server page
 * reads `?q=` from its searchParams and passes to the query.
 */
export function SearchBar({
  paramName = "q",
  placeholder = "Search…",
  className = "",
  /** When the search changes, these other params (e.g. page) are dropped
   *  so the user lands on the first page of the new filtered set. */
  resetParams = ["page"],
  /** Milliseconds to wait after the last keystroke before pushing the URL. */
  debounceMs = 300,
}: {
  paramName?: string
  placeholder?: string
  className?: string
  resetParams?: string[]
  debounceMs?: number
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlValue = searchParams.get(paramName) ?? ""

  const [value, setValue] = useState(urlValue)
  const [pending, startTransition] = useTransition()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastCommittedRef = useRef(urlValue)

  // If the URL value changes externally (back/forward nav, link click),
  // sync the local input. Avoid clobbering the user's in-flight typing.
  useEffect(() => {
    if (urlValue !== lastCommittedRef.current) {
      setValue(urlValue)
      lastCommittedRef.current = urlValue
    }
  }, [urlValue])

  function commit(next: string) {
    const trimmed = next.trim()
    if (trimmed === lastCommittedRef.current) return
    lastCommittedRef.current = trimmed

    const params = new URLSearchParams(searchParams.toString())
    if (trimmed) {
      params.set(paramName, trimmed)
    } else {
      params.delete(paramName)
    }
    for (const p of resetParams) params.delete(p)

    const qs = params.toString()
    const href = (qs ? `${pathname}?${qs}` : pathname) as never
    startTransition(() => {
      router.replace(href)
    })
  }

  function onChange(next: string) {
    setValue(next)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => commit(next), debounceMs)
  }

  function clear() {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setValue("")
    commit("")
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  return (
    <div
      className={cn(
        // Default size — compact enough to fit inline in a card header.
        // Callers can override via className (tailwind-merge wins).
        "relative inline-flex items-center w-64",
        className,
      )}
    >
      <Search
        className={cn(
          "absolute left-2.5 w-3.5 h-3.5 pointer-events-none",
          pending ? "text-cyan animate-pulse" : "text-ink-mute",
        )}
        strokeWidth={2}
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (debounceRef.current) clearTimeout(debounceRef.current)
            commit(value)
          } else if (e.key === "Escape") {
            e.preventDefault()
            clear()
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="w-full bg-[#0E1C2A] border border-line rounded-md pl-7 pr-7 py-1.5 text-[12px] text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"
      />
      {value && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear search"
          className="absolute right-2 text-ink-mute hover:text-ink transition-colors"
        >
          <X className="w-3 h-3" strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}
