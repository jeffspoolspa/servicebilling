import { type ReactNode } from "react"

interface ObjectHeaderProps {
  eyebrow?: string
  title: string
  sub?: string
  icon?: ReactNode
  actions?: ReactNode
}

export function ObjectHeader({ eyebrow, title, sub, icon, actions }: ObjectHeaderProps) {
  return (
    <header className="px-7 pt-6 flex items-start gap-4.5 border-b border-line-soft pb-6 animate-fadeup">
      {icon && (
        <div className="w-13 h-13 rounded-xl bg-[radial-gradient(circle_at_30%_20%,rgb(56_189_248),rgb(14_165_233)_60%,rgb(11_79_116))] grid place-items-center text-[#061018] shadow-[0_12px_30px_-12px_rgb(56_189_248_/_0.33)]">
          {icon}
        </div>
      )}
      <div className="flex flex-col gap-1">
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
