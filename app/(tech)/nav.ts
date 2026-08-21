import { Package, ClipboardList, FlaskConical } from "lucide-react"

// The tech app's modules — one list, two surfaces: the side drawer (names)
// and the bottom bar's idle quick-access row (icons). `match` keeps a module
// active across its sub-pages.
export const MODULES = [
  {
    href: "/truck-check",
    label: "Inventory",
    icon: Package,
    match: ["/truck-check", "/sign-out"],
  },
  {
    href: "/follow-up",
    label: "Follow-Up",
    icon: ClipboardList,
    match: ["/follow-up"],
  },
  {
    href: "/dosing",
    label: "Dosing",
    icon: FlaskConical,
    match: ["/dosing"],
  },
] as const

export function visibleModules(hideInventory: boolean) {
  return hideInventory ? MODULES.filter((m) => m.href !== "/truck-check") : [...MODULES]
}
