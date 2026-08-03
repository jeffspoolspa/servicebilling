import "server-only"
import { triggerScriptSync } from "@/lib/windmill"
import type { QboKeys, QboMinter } from "./qbo"

/**
 * The ONE way the app gets QBO keys: the Windmill minter script
 * (f/qbo/api/get_access_token) — the single owner of the rotating refresh
 * token (ADR 012). The app never refreshes; it asks.
 */
export class WindmillQboMinter implements QboMinter {
  async mint(force: boolean): Promise<QboKeys> {
    const keys = await triggerScriptSync<{ access_token: string; realm_id: string }>(
      "f/qbo/api/get_access_token",
      force ? { force: true } : {},
      { timeoutMs: 60000 },
    )
    if (!keys?.access_token || !keys?.realm_id) throw new Error("QBO minter returned no keys")
    return keys
  }
}
