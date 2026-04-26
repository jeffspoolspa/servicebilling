"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils/cn"

/**
 * Office tab strip for routes / visits pages. Picks office from
 * ?office=<name>. The "All" tab clears the param.
 */
export function OfficeTabs({
  offices,
  counts,
}: {
  offices: string[]
  counts?: Record<string, number>
}) {
  const path = usePathname()
  const params = useSearchParams()
  const current = params.get("office") ?? ""

  function hrefFor(office: string): string {
    if (!office) return path
    const sp = new URLSearchParams(params)
    sp.set("office", office)
    return `${path}?${sp.toString()}`
  }
  function clearHref(): string {
    const sp = new URLSearchParams(params)
    sp.delete("office")
    const qs = sp.toString()
    return qs ? `${path}?${qs}` : path
  }

  return (
    <div className="flex gap-1 px-7 pt-3 border-b border-line-soft">
      <TabLink href={clearHref()} active={current === ""} label="All" />
      {offices.map((o) => (
        <TabLink
          key={o}
          href={hrefFor(o)}
          active={current === o}
          label={o}
          count={counts?.[o]}
        />
      ))}
    </div>
  )
}

function TabLink({
  href,
  active,
  label,
  count,
}: {
  href: string
  active: boolean
  label: string
  count?: number
}) {
  return (
    <Link
      href={href as never}
      className={cn(
        "px-3.5 py-2 text-[13px] -mb-px border-b-2 flex items-center gap-2",
        active
          ? "text-ink border-cyan font-medium"
          : "text-ink-mute border-transparent hover:text-ink",
      )}
    >
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "text-[10px] font-mono px-1.5 rounded",
            active ? "bg-cyan/20 text-cyan" : "bg-white/5 text-ink-mute",
          )}
        >
          {count}
        </span>
      )}
    </Link>
  )
}
