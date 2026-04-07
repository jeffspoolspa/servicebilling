import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"

interface TopbarProps {
  crumbs?: Array<{ label: string; href?: string }>
}

export function Topbar({ crumbs = [] }: TopbarProps) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-3.5 px-7 py-3.5 border-b border-line-soft bg-[#0A1622]/80 backdrop-blur-md">
      <div className="text-xs text-ink-mute flex gap-2 items-center">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-2">
            {i > 0 && <span>/</span>}
            <span className={i === crumbs.length - 1 ? "text-ink font-medium" : ""}>{c.label}</span>
          </span>
        ))}
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
