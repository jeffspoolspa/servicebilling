import Link from "next/link"
import { cn } from "@/lib/utils/cn"

/**
 * URL-driven tab switcher for the WO detail page.
 * `?tab=work` or `?tab=invoice` (default depends on whether invoice exists).
 *
 * Rendered INSIDE the panel's own CardHeader, in place of its title — the two
 * views are two faces of one card, not two pages behind a nav bar. The header
 * already draws the bottom rule, so the active tab's underline lands on it.
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
  /** The matched invoice's QBO doc number, so the tab names what it shows. */
  docNumber?: string | null
}

export function DetailTabs({
  active,
  woNumber,
  invoiceAttention,
  invoiceDisabled,
  docNumber,
}: Props) {
  return (
    <div className="flex items-center gap-1 -ml-2">
      <TabLink
        href={`/work-orders/${woNumber}?tab=work` as never}
        active={active === "work"}
      >
        Work order {woNumber}
      </TabLink>
      {invoiceDisabled ? (
        <div
          className="px-2.5 py-2 text-[12px] uppercase tracking-[0.08em] text-ink-mute/40 cursor-not-allowed"
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
          Invoice {docNumber ?? ""}
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
        "relative px-2.5 py-2 text-[12px] uppercase tracking-[0.08em] font-medium transition-colors",
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
