import Link from "next/link"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BackButton } from "@/components/shell/back-button"

interface TopbarProps {
  crumbs?: Array<{ label: string; href?: string }>
  /** Show a back arrow button to the left of the crumbs (uses browser history). */
  back?: boolean
  /** Where to send the user if they hit Back with no history (rarely needed). */
  backFallbackHref?: string
}

export function Topbar({ crumbs = [], back = false, backFallbackHref }: TopbarProps) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-3.5 px-7 py-3.5 border-b border-line-soft bg-[#0A1622]/80 backdrop-blur-md">
      {back && <BackButton fallbackHref={backFallbackHref} />}
      <div className="text-xs text-ink-mute flex gap-2 items-center">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1
          return (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && <span>/</span>}
              {c.href && !isLast ? (
                <Link
                  href={c.href as never}
                  className="text-ink-mute hover:text-cyan transition-colors"
                >
                  {c.label}
                </Link>
              ) : (
                <span className={isLast ? "text-ink font-medium" : ""}>{c.label}</span>
              )}
            </span>
          )
        })}
      </div>

      <div className="ml-auto flex items-center gap-2 bg-[#0E1C2A] border border-line rounded-lg px-3 py-1.5 w-80 text-ink-mute text-[13px]">
        <Search className="w-3.5 h-3.5" />
        <span className="flex-1">Search work orders, invoices, customers…</span>
        <kbd className="font-mono text-[10px] bg-white/5 px-1.5 py-0.5 rounded border border-line">
          ⌘K
        </kbd>
      </div>

      <Button>Run Sync</Button>
      <Button variant="primary">Process</Button>

      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-teal to-cyan grid place-items-center font-semibold text-[#061018] text-xs">
        CG
      </div>
    </div>
  )
}
