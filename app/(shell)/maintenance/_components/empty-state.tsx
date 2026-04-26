import type { ReactNode } from "react"

/**
 * Module-private empty state for the maintenance scaffold pages. Each page is
 * a stub until the corresponding feature plan (ingest flows, generator, etc.)
 * lands; this component keeps them visually consistent without leaking into
 * shared `components/`.
 */
export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex-1 grid place-items-center px-7 py-16">
      <div className="flex flex-col items-center gap-3 text-center max-w-sm">
        <div className="w-12 h-12 rounded-full bg-cyan/10 border border-cyan/20 grid place-items-center">
          {icon}
        </div>
        <div className="text-ink font-medium">{title}</div>
        <div className="text-ink-mute text-[12px]">{description}</div>
      </div>
    </div>
  )
}
