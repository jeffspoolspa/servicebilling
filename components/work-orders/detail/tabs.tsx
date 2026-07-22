import Link from "next/link"
import { cn } from "@/lib/utils/cn"

/**
 * URL-driven tab switcher for the WO detail page.
 * `?tab=work` or `?tab=invoice` (default depends on whether invoice exists).
 *
 * Server-rendered via Link — no client JS, navigation preserves scroll
 * position when Next's router handles it.
 */
export type DetailTab = "work" | "invoice"

interface Props {
  active: DetailTab
  /** The WO number — used to construct the hrefs. */
  woNumber: string
  /** When true, show a small dot on the Invoice tab to indicate attention. */
  invoiceAttention?: boolean
  /** When true, Invoice tab is disabled (WO not linked). */
  invoiceDisabled?: boolean
}

export function DetailTabs({ active, woNumber, invoiceAttention, invoiceDisabled }: Props) {
  return (
    <div className="flex items-center gap-1 border-b border-line-soft">
      <TabLink
        href={`/work-orders/${woNumber}?tab=work` as never}
        active={active === "work"}
      >
        Work order
      </TabLink>
      {invoiceDisabled ? (
        <div
          className="px-4 py-2 text-[12px] uppercase tracking-[0.08em] text-ink-mute/40 cursor-not-allowed"
          title="Invoice not yet matched"
        >
          Invoice
        </div>
      ) : (
        <TabLink
          href={`/work-orders/${woNumber}?tab=invoice` as never}
          active={active === "invoice"}
          attention={invoiceAttention}
        >
          Invoice
        </TabLink>
      )}
    </div>
  )
}

function TabLink({
  href,
  active,
  attention,
  children,
}: {
  href: string
  active: boolean
  attention?: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href as never}
      scroll={false}
      className={cn(
        "relative px-4 py-2 text-[12px] uppercase tracking-[0.08em] font-medium transition-colors",
        active
          ? "text-ink border-b-2 border-cyan -mb-px"
          : "text-ink-mute hover:text-ink",
      )}
    >
      {children}
      {attention && !active && (
        <span className="absolute top-1.5 right-1 w-1.5 h-1.5 rounded-full bg-coral" />
      )}
    </Link>
  )
}
