import { type ReactNode } from "react"

interface ObjectHeaderProps {
  eyebrow?: string
  title: string
  sub?: string
  icon?: ReactNode
  actions?: ReactNode
}

/**
 * Page-level header: eyebrow + title + optional icon badge + right-side
 * actions. The icon badge is deliberately understated — a tinted square
 * with a cyan-stroked icon — rather than a heavy radial-gradient tile.
 * Matches the tonal treatment used by empty-states across the app
 * (`bg-<tone>/15 border border-<tone>/30`), so the icon reads as an
 * affordance, not a focal point that fights with the title.
 */
export function ObjectHeader({ eyebrow, title, sub, icon, actions }: ObjectHeaderProps) {
  return (
    <header className="px-7 pt-6 flex items-start gap-4 border-b border-line-soft pb-6 animate-fadeup">
      {icon && (
        // [&_svg] normalizes whatever sizing/stroke the caller passed so the
        // icon reads consistently across every ObjectHeader.
        <div className="w-10 h-10 rounded-lg bg-cyan/10 border border-cyan/20 grid place-items-center text-cyan shrink-0 mt-0.5 [&_svg]:w-[18px] [&_svg]:h-[18px] [&_svg]:[stroke-width:1.8]">
          {icon}
        </div>
      )}
      <div className="flex flex-col gap-1 min-w-0">
        {eyebrow && (
          <div className="text-[11px] uppercase tracking-[0.16em] text-cyan">{eyebrow}</div>
        )}
        <h1 className="text-3xl font-display tracking-tight">{title}</h1>
        {sub && <div className="text-ink-dim text-[13px]">{sub}</div>}
      </div>
      {actions && <div className="ml-auto flex gap-2">{actions}</div>}
    </header>
  )
}
