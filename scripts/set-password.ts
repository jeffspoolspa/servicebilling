#!/usr/bin/env tsx
/**
 * One-off CLI to set an office user's password.
 *
 *   npm run set-password -- carter@jeffspoolspa.com 'mypass'
 *
 * Uses the service-role key from .env.local, so this only runs locally.
 * Never deploy this as an HTTP endpoint — it'd be an account-takeover vector.
 *
 * If the user doesn't exist yet, we create them (email-verified by default,
 * so they can sign in immediately without confirming an email).
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createClient } from "@supabase/supabase-js"

// Manually load .env.local so this works under plain tsx/node without
// needing `--env-file` or any external loader.
function loadEnvLocal() {
  try {
    const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8")
    for (const raw of text.split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      const eq = line.indexOf("=")
      if (eq < 0) continue
      const k = line.slice(0, eq).trim()
      let v = line.slice(eq + 1).trim()
      // Strip surrounding quotes if present
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (!(k in process.env)) process.env[k] = v
    }
  } catch {
    // .env.local missing — fall through, next check will catch it
  }
}
loadEnvLocal()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  console.error("Make sure .env.local is populated.")
  process.exit(1)
}

const [, , emailArg, passwordArg] = process.argv
if (!emailArg || !passwordArg) {
  console.error("Usage: bun run scripts/set-password.ts <email> <password>")
  process.exit(1)
}
const email = emailArg.trim().toLowerCase()
const password = passwordArg
if (password.length < 8) {
  console.error("Password must be at least 8 characters.")
  process.exit(1)
}

async function main() {
  const admin = createClient(url!, key!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Find existing user by email. listUsers() is paginated (up to 1000/page) —
  // fine for our scale but paginate if you ever have >1k.
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 })
  if (listErr) {
    console.error("listUsers failed:", listErr.message)
    process.exit(1)
  }
  const existing = list.users.find((u) => u.email?.toLowerCase() === email)

  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing.id, { password })
    if (error) {
      console.error("updateUserById failed:", error.message)
      process.exit(1)
    }
    console.log(`✓ Password set for existing user ${email} (${existing.id})`)
    return
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) {
    console.error("createUser failed:", error.message)
    process.exit(1)
  }
  console.log(`✓ Created ${email} with password (${data.user?.id})`)
  console.log("  You may want to create a public.employees row linked to this auth_user_id.")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
