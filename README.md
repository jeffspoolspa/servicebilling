# Jeff's Internal

The internal operations app for Jeff's Pool & Spa Service. One Next.js app, one repo, modular feature folders. First module is service billing.

## Stack

- **Next.js 15** (App Router, RSC, TypeScript)
- **Tailwind CSS** with custom design tokens (pool-company palette)
- **Supabase** — Postgres, Auth, RLS (project `vvprodiuwraceabviyes`)
- **Vercel** — deploy target (`internal.jeffspoolspa.com`)
- **Windmill** — automation jobs (mirrored to `windmill/`)

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in Supabase keys
npm run dev
```

Open http://localhost:3000

## Layout

```
app/                  Next.js App Router routes
  (auth)/             Login, magic-link callback (no shell)
  (shell)/            Authenticated routes (rail + topbar)
    page.tsx          Home dashboard
    customers/        Customer entity pages
    work-orders/      Work order entity pages
    employees/        Employee entity pages
    invoices/         Invoice entity pages
    service-billing/  Service billing module
    admin/            Admin tools
components/
  ui/                 Design system primitives (Button, Card, Pill, ...)
  shell/              Chrome (Rail, Topbar, Nav, ObjectHeader, Tabs)
  entities/           Reusable entity displays (CustomerCard, etc.)
lib/
  supabase/           Server + browser clients
  auth/               requireRole, getCurrentEmployee
  entities/           Entity modules (types, queries, mutations, rules)
    customer/
    work-order/
    invoice/
    employee/
  db/
    types.ts          Generated Supabase types
  utils/              cn, format helpers
supabase/
  migrations/         SQL files (timestamped, applied in order)
  functions/          Edge functions (Deno)
windmill/             Windmill script mirror — see windmill/README.md
scripts/              One-off operational scripts (tsx)
```

## Architecture rules

1. **Entity vs module split.** Top-level URLs (`/customers`, `/work-orders`) are entities — owned by no module. Modules (`/service-billing`) are workflow surfaces that contribute to entities.
2. **One Supabase project** backs everything. Schemas: `public.*` for shared entities, `<module>.*` for module-owned tables.
3. **Level 1 entity rigor.** All writes funnel through `lib/entities/<name>/mutations.ts`. Direct table writes from route handlers are not allowed.
4. **Modules are folders, not packages.** Promote to packages only when forced by runtime, deploy cadence, or build-time pain.

## Adding a new module

1. `mkdir app/(shell)/<module-name>`
2. Add `page.tsx`, child routes, `_lib/`, `_components/`
3. Add nav link in `components/shell/rail.tsx` and `components/shell/nav.tsx`
4. Insert `app_roles` rows for the module
5. Add a migration in `supabase/migrations/` if new tables needed
6. If the module needs a tab on an entity page, add it under `app/(shell)/<entity>/[id]/_components/tabs/`

## Adding a new entity

Promote a table to an entity when ≥2 modules need to write to it OR users would deep-link to it.

1. Create `lib/entities/<name>/{types,queries,mutations,rules,events,index}.ts`
2. Create `app/(shell)/<name>/page.tsx` and `app/(shell)/<name>/[id]/page.tsx`
3. Add nav item in `components/shell/rail.tsx` and `components/shell/nav.tsx`

## Conventions

- **Server components by default.** Only use `"use client"` when you need state, effects, or browser APIs.
- **Route handlers for forms.** Use Next.js server actions or route handlers, not custom API routes.
- **No raw table writes outside entity modules.** PR review enforces this.
- **No secrets in git.** Use `.env.local` and Vercel env vars.

## See also

- `~/.claude/plans/purrfect-sauteeing-goblet.md` — full implementation plan
- `windmill/README.md` — Windmill sync workflow
- `scripts/README.md` — operational scripts
