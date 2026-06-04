/**
 * Module manifest — single source of truth for what apps exist, which
 * routes belong to each, and which roles are valid within each.
 *
 * Used by:
 *   - lib/auth/access.ts              — to evaluate user access decisions
 *   - components/shell/sidebar.tsx    — to decide which top-level items to render
 *   - app/(shell)/admin/users/*       — to populate the access matrix UI
 *   - middleware                      — to map paths to required modules
 *
 * Adding a new module? Add it here, then assign access via /admin/users.
 *
 * The `app_roles` table stores `(auth_user_id, app, role)` rows where `app`
 * is one of the keys below and `role` is one of the keys under `roles`.
 * A user can have multiple rows (one per module they have access to).
 */

export type ModuleKey = "service" | "maintenance" | "leads" | "admin"
export type RoleKey = "viewer" | "admin"

export interface RoleSpec {
  /** Human label for the access matrix UI. */
  label: string
  /** Whether this role can perform mutating actions. The single canonical
   *  flag every guard / UI hide check should consult. */
  canWrite: boolean
}

export interface ModuleSpec {
  key: ModuleKey
  /** Display name in sidebar + admin UI. */
  label: string
  /** One-line description shown in the access matrix. */
  description: string
  /** Path prefixes that belong to this module. A request whose path starts
   *  with any of these is gated against this module's roles. Order matters
   *  only for diagnostics — `routeToModule()` returns the first match. */
  routes: string[]
  /** Available roles within the module. Listed admin-first so the UI
   *  shows the more powerful option as the default toggle target. */
  roles: Partial<Record<RoleKey, RoleSpec>>
}

export const MODULES: Record<ModuleKey, ModuleSpec> = {
  service: {
    key: "service",
    label: "Service",
    description: "Service billing, work orders, invoices, employees.",
    routes: [
      "/service",
      "/service-billing",
      "/work-orders",
      "/invoices",
      "/employees",
    ],
    roles: {
      admin:  { label: "Admin",  canWrite: true  },
      viewer: { label: "Viewer", canWrite: false },
    },
  },
  maintenance: {
    key: "maintenance",
    label: "Maintenance",
    description: "Pool maintenance dispatch + technician operations.",
    routes: ["/maintenance"],
    roles: {
      admin: { label: "Admin", canWrite: true },
    },
  },
  leads: {
    key: "leads",
    label: "Leads",
    description: "Maintenance lead intake, follow-up, and conversion.",
    routes: ["/leads"],
    roles: {
      admin:  { label: "Admin",  canWrite: true  },
      viewer: { label: "Viewer", canWrite: false },
    },
  },
  admin: {
    key: "admin",
    label: "Admin",
    description: "User management, sync diagnostics, classification rules.",
    routes: ["/admin"],
    roles: {
      admin: { label: "Admin", canWrite: true },
    },
  },
}

/** Routes that are public — no auth check. */
export const PUBLIC_ROUTES = [
  "/login",
  "/tech-login",
  "/auth",
  "/logout",
  "/api/webhooks",
  "/api/leads", // external website lead intake — gated by x-api-key in the route, not session
  "/unauthorized",
]

/** Routes that any authenticated user can hit, regardless of module access.
 *  Landing pages and unauthorized handler. */
export const AUTHENTICATED_ROUTES = [
  "/home",
  "/unauthorized",
]

/**
 * Map a request path to the module it belongs to (or null if none).
 * Used by middleware + page guards to decide which app_roles row is required.
 */
export function routeToModule(path: string): ModuleKey | null {
  for (const mod of Object.values(MODULES)) {
    for (const prefix of mod.routes) {
      if (path === prefix || path.startsWith(prefix + "/")) {
        return mod.key
      }
    }
  }
  return null
}

/**
 * True when this path requires no auth at all (login page, webhooks).
 */
export function isPublicRoute(path: string): boolean {
  return PUBLIC_ROUTES.some((p) => path === p || path.startsWith(p + "/"))
}

/**
 * True when this path is reachable by any authenticated user, regardless
 * of which modules they have access to (e.g. /home, /unauthorized).
 */
export function isAuthenticatedOnlyRoute(path: string): boolean {
  return AUTHENTICATED_ROUTES.some((p) => path === p || path.startsWith(p + "/"))
}
