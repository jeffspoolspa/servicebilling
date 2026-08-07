"use client"

import { useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

/**
 * Walk the months list from the DETAIL page — prev/next follow the same
 * status filter the table had (flag-to-flag when it was `held`). Arrow
 * keys work too, unless focus is in an input.
 */
export function MonthNav({
  prevHref,
  nextHref,
  label,
}: {
  prevHref: string | null
  nextHref: string | null
  label: string
}) {
  const router = useRouter()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      if (e.key === "ArrowLeft" && prevHref) router.push(prevHref as never)
      if (e.key === "ArrowRight" && nextHref) router.push(nextHref as never)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [prevHref, nextHref, router])

  const btn = (href: string | null, text: string) =>
    href ? (
      <Link href={href as never} className="h-7 px-3 inline-flex items-center rounded-lg border border-line text-[12px] text-ink-dim hover:text-ink hover:border-line/80">
        {text}
      </Link>
    ) : (
      <span className="h-7 px-3 inline-flex items-center rounded-lg border border-line/40 text-[12px] text-ink-mute/50">{text}</span>
    )

  return (
    <span className="inline-flex items-center gap-1.5">
      {btn(prevHref, "‹ Prev")}
      <span className="text-[11.5px] text-ink-mute px-1">{label}</span>
      {btn(nextHref, "Next ›")}
    </span>
  )
}
