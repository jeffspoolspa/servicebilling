"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Search as SearchIcon } from "lucide-react"

/**
 * URL-driven search input for the work-orders browser. Mounted in the
 * table CardHeader so it sits on the same baseline as the title /
 * count pill / Download CSV button — keeps the filter row beneath
 * uncluttered.
 *
 * Local state keeps typing snappy; commits to the URL `q` param on a
 * 300ms debounce. External URL changes (Back button, chip removal)
 * sync back into the input via the searchParams effect.
 */
export function WorkOrdersSearchInput() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [value, setValue] = useState(searchParams.get("q") ?? "")
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync from URL when it changes externally
  useEffect(() => {
    setValue(searchParams.get("q") ?? "")
  }, [searchParams])

  // Debounced commit
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const current = searchParams.get("q") ?? ""
      if (value === current) return
      const next = new URLSearchParams(searchParams.toString())
      if (value.trim()) next.set("q", value)
      else next.delete("q")
      next.delete("page") // any filter change resets pagination
      router.replace(`${pathname}?${next.toString()}` as never)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [value, searchParams, router, pathname])

  return (
    <div className="relative">
      <SearchIcon
        className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-mute"
        strokeWidth={1.8}
      />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search WO, customer, invoice #…"
        className="bg-bg-elev border border-line rounded-md pl-8 pr-2.5 py-1.5 text-[12px] text-ink w-72 placeholder:text-ink-mute focus:outline-none focus:border-cyan"
      />
    </div>
  )
}
