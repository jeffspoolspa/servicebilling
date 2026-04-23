"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useMemo } from "react"
import { cn } from "@/lib/utils/cn"

/**
 * Persistent top header inside the shell. Two stacked strips:
 *
 *   1. Module nav strip — contextual links across the top for the CURRENT
 *      top-level module (Service has: Dashboard | Billing). Replaces the
 *      search / Run Sync / Process slot that used to live here.
 *
 *   2. Breadcrumb strip — one subtle line derived from the pathname, so
 *      you always see where you are on deep pages (WO detail etc).
 *
 * Avatar sits far right of strip 1.
 */

interface ModuleLink {
  href: string
  label: string
  /** Prefixes that count as "this tab is active". */
  matches: string[]
}

const SERVICE_LINKS: ModuleLink[] = [
  {
    href: "/service",
    label: "Dashboard",
    matches: ["/service"],
  },
  {
    href: "/work-orders",
    label: "Work Orders",
    matches: ["/work-orders"],
  },
  {
    href: "/service-billing",
    label: "Billing",
    matches: [
      "/service-billing",
      "/invoices",
      "/customers",
    ],
  },
]

/** Module link set per top-level department. Add more modules (Maintenance
 *  sub-nav, Admin sub-nav) as the app grows. */
function moduleLinksFor(path: string): ModuleLink[] | null {
  if (
    path.startsWith("/service") ||
    path.startsWith("/work-orders") ||
    path.startsWith("/invoices") ||
    path.startsWith("/customers")
  ) {
    return SERVICE_LINKS
  }
  // /home, /maintenance, /admin/*, /employees have no module sub-nav yet.
  return null
}

export function ModuleHeader() {
  const path = usePathname()
  const links = moduleLinksFor(path)
  const crumbs = useMemo(() => deriveCrumbs(path), [path])

  // Crumbs only render on genuinely-deep pages (WO detail, customer detail,
  // etc). On module-root + tab pages the Sidebar + module nav + Tabs
  // already tell you where you are, so the crumb is pure clutter.
  //
  // Detection: shallow paths are the module roots (/service, /home,
  // /maintenance, /admin) + anything whose deepest segment is one of the
  // 5 billing tabs or a known entity list. Everything else (e.g.
  // /work-orders/12345, /customers/ABC/invoices) gets the quiet crumb.
  const shallowPatterns = [
    /^\/$/,
    /^\/home$/,
    /^\/maintenance$/,
    /^\/service$/,
    /^\/service-billing$/,
    /^\/service-billing\/(awaiting-invoice|queue|needs-attention|sent|audit|triage|activity|payment-methods|past-due|revenue)$/,
    /^\/work-orders$/,
    /^\/invoices$/,
    /^\/customers$/,
    /^\/employees$/,
    /^\/admin$/,
    /^\/admin\/[^/]+$/,
  ]
  const showCrumbs = !shallowPatterns.some((r) => r.test(path)) && crumbs.length > 0

  return (
    <header className="sticky top-0 z-20 bg-[#0A1622]/85 backdrop-blur-md border-b border-line-soft">
      <div className="flex items-center px-7 h-11">
        <nav className="flex items-center gap-1 -ml-2">
          {links?.map((l) => {
            const active = l.matches.some(
              (m) => path === m || path.startsWith(m + "/"),
            )
            return (
              <Link
                key={l.href}
                href={l.href as never}
                className={cn(
                  "relative px-3 py-1.5 text-[13px] rounded-md transition-colors",
                  active
                    ? "text-ink"
                    : "text-ink-mute hover:text-ink hover:bg-white/[0.03]",
                )}
              >
                {l.label}
                {active && (
                  <span className="absolute left-3 right-3 -bottom-px h-0.5 bg-cyan rounded-full" />
                )}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {showCrumbs && (
            <div className="hidden md:flex items-center gap-1 text-[10px] text-ink-mute/70 font-mono tracking-tight">
              {crumbs.map((c, i) => {
                const isLast = i === crumbs.length - 1
                return (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-ink-mute/40">/</span>}
                    {c.href && !isLast ? (
                      <Link
                        href={c.href as never}
                        className="hover:text-ink-dim transition-colors"
                      >
                        {c.label}
                      </Link>
                    ) : (
                      <span className={cn(isLast && "text-ink-dim")}>{c.label}</span>
                    )}
                  </span>
                )
              })}
            </div>
          )}
          <div
            className="w-8 h-8 rounded-full bg-gradient-to-br from-teal to-cyan grid place-items-center font-semibold text-[#061018] text-xs"
            title="Carter Gasia"
          >
            CG
          </div>
        </div>
      </div>
    </header>
  )
}

interface Crumb {
  label: string
  href?: string
}

function deriveCrumbs(path: string): Crumb[] {
  if (path === "/" || path === "") return []
  if (path === "/home") return [{ label: "Home" }]
  if (path === "/maintenance") return [{ label: "Maintenance" }]

  // /service → Service · Dashboard
  if (path === "/service") {
    return [{ label: "Service" }, { label: "Dashboard" }]
  }

  // /service-billing/* → Service · Billing · <tab>
  if (path.startsWith("/service-billing")) {
    const parts = path.split("/").filter(Boolean) // ['service-billing', 'foo', '…']
    const crumbs: Crumb[] = [
      { label: "Service", href: "/service" },
      { label: "Billing", href: "/service-billing" },
    ]
    if (parts.length > 1) {
      crumbs.push({ label: titleize(parts[1]) })
    }
    return crumbs
  }

  // /work-orders, /invoices, /customers live conceptually under Service ·
  // Billing for now — show the deep page name.
  if (path.startsWith("/work-orders")) {
    const parts = path.split("/").filter(Boolean)
    const crumbs: Crumb[] = [
      { label: "Service", href: "/service" },
      { label: "Billing", href: "/service-billing" },
      { label: "Work Orders", href: "/work-orders" },
    ]
    if (parts.length > 1) crumbs.push({ label: parts[1] })
    return crumbs
  }
  if (path.startsWith("/invoices")) {
    const parts = path.split("/").filter(Boolean)
    const crumbs: Crumb[] = [
      { label: "Service", href: "/service" },
      { label: "Billing", href: "/service-billing" },
      { label: "Invoices", href: "/invoices" },
    ]
    if (parts.length > 1) crumbs.push({ label: parts[1] })
    return crumbs
  }
  if (path.startsWith("/customers")) {
    const parts = path.split("/").filter(Boolean)
    const crumbs: Crumb[] = [
      { label: "Service", href: "/service" },
      { label: "Billing", href: "/service-billing" },
      { label: "Customers", href: "/customers" },
    ]
    if (parts.length > 1) crumbs.push({ label: parts[1] })
    return crumbs
  }
  if (path.startsWith("/employees")) {
    const parts = path.split("/").filter(Boolean)
    const crumbs: Crumb[] = [{ label: "Employees", href: "/employees" }]
    if (parts.length > 1) crumbs.push({ label: parts[1] })
    return crumbs
  }
  if (path.startsWith("/admin")) {
    const parts = path.split("/").filter(Boolean)
    const crumbs: Crumb[] = [{ label: "Admin", href: "/admin" }]
    if (parts.length > 1) crumbs.push({ label: titleize(parts[1]) })
    return crumbs
  }

  return []
}

function titleize(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}
