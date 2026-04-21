import Link from "next/link"
import { ChevronDown, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * Column header that toggles sort via URL search params.
 *
 * - Clicking the active column flips direction (asc ↔ desc).
 * - Clicking an inactive column switches to it, default direction = desc for
 *   numeric/date columns, asc for text columns.
 * - Arrow icon shows the current sort column + direction.
 *
 * The parent page reads the resulting `sort` and `dir` search params and
 * passes them to the data query.
 */
interface SortableHeaderProps {
  label: string
  column: string
  currentSort: string
  currentDir: "asc" | "desc"
  basePath: string
  /** Other search params to preserve when changing sort (filters etc.) */
  preserve?: Record<string, string | undefined>
  /** Default direction when first clicking this column. Default "desc". */
  defaultDir?: "asc" | "desc"
  /** URL param name for the sort column. Default "sort". */
  sortParam?: string
  /** URL param name for the sort direction. Default "dir". */
  dirParam?: string
  /** URL param name for the page number (reset on sort change). Default "page". */
  pageParam?: string
  className?: string
  align?: "left" | "right"
}

export function SortableHeader({
  label,
  column,
  currentSort,
  currentDir,
  basePath,
  preserve = {},
  defaultDir = "desc",
  sortParam = "sort",
  dirParam = "dir",
  pageParam = "page",
  className,
  align = "left",
}: SortableHeaderProps) {
  const active = currentSort === column
  const nextDir: "asc" | "desc" = active
    ? currentDir === "asc"
      ? "desc"
      : "asc"
    : defaultDir

  const params = new URLSearchParams()
  params.set(sortParam, column)
  params.set(dirParam, nextDir)
  // Reset to page 1 when changing sort (omit pageParam from params)
  for (const [k, v] of Object.entries(preserve)) {
    if (v != null && k !== pageParam && k !== sortParam && k !== dirParam) params.set(k, v)
  }
  const href = `${basePath}?${params.toString()}`

  return (
    <Link
      href={href as never}
      className={cn(
        "inline-flex items-center gap-1 cursor-pointer transition-colors",
        active ? "text-ink" : "text-ink-mute hover:text-ink",
        align === "right" && "flex-row-reverse justify-end",
        className,
      )}
    >
      <span>{label}</span>
      {active ? (
        currentDir === "asc" ? (
          <ChevronUp className="w-3 h-3" strokeWidth={2.5} />
        ) : (
          <ChevronDown className="w-3 h-3" strokeWidth={2.5} />
        )
      ) : (
        <ChevronDown className="w-3 h-3 opacity-20" strokeWidth={2.5} />
      )}
    </Link>
  )
}
