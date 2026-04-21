import Link from "next/link"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * Server-rendered pagination bar. Links update URL search params (`page=N`),
 * preserving any other params (sort, filters).
 */
interface PaginationProps {
  basePath: string
  page: number
  perPage: number
  total: number
  /** Other params to preserve in the href (e.g. sort, dir, tab). */
  preserve?: Record<string, string | undefined>
  /** URL param name for page number. Default "page". */
  pageParam?: string
  className?: string
}

export function Pagination({
  basePath,
  page,
  perPage,
  total,
  preserve = {},
  pageParam = "page",
  className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  const hasPrev = page > 1
  const hasNext = page < totalPages
  const from = total === 0 ? 0 : (page - 1) * perPage + 1
  const to = Math.min(page * perPage, total)

  function href(targetPage: number) {
    const params = new URLSearchParams()
    params.set(pageParam, String(targetPage))
    for (const [k, v] of Object.entries(preserve)) {
      if (v != null && k !== pageParam) params.set(k, v)
    }
    return `${basePath}?${params.toString()}`
  }

  if (totalPages <= 1) {
    return (
      <div className={cn("flex items-center justify-between px-5 py-2.5 text-[11px] text-ink-mute", className)}>
        <span>
          {total} {total === 1 ? "row" : "rows"}
        </span>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex items-center justify-between px-5 py-2.5 border-t border-line-soft text-[11px]",
        className,
      )}
    >
      <span className="text-ink-mute">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        {hasPrev ? (
          <Link
            href={href(page - 1) as never}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-line text-ink-dim hover:border-cyan hover:text-cyan transition-colors"
          >
            <ChevronLeft className="w-3 h-3" strokeWidth={2.5} />
            Prev
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded border border-line-soft text-ink-mute opacity-50">
            <ChevronLeft className="w-3 h-3" strokeWidth={2.5} />
            Prev
          </span>
        )}
        <span className="px-2 text-ink-dim">
          Page {page} of {totalPages}
        </span>
        {hasNext ? (
          <Link
            href={href(page + 1) as never}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-line text-ink-dim hover:border-cyan hover:text-cyan transition-colors"
          >
            Next
            <ChevronRight className="w-3 h-3" strokeWidth={2.5} />
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded border border-line-soft text-ink-mute opacity-50">
            Next
            <ChevronRight className="w-3 h-3" strokeWidth={2.5} />
          </span>
        )}
      </div>
    </div>
  )
}
