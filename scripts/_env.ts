/**
 * Load .env.local BEFORE any lib module is evaluated. Import this FIRST:
 * modules like lib/places/resolve read env at import time, so a loader that
 * runs after the import graph settles silently hands them nothing.
 */
import { readFileSync } from "node:fs"

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
}
