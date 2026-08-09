/**
 * The Inngest client — the DELIVERY layer only (RULED 2026-08-09).
 * Functions defined on it are PRESENTATION-tier hosts, peers of API
 * routes and script harnesses: they receive an event or a cron tick,
 * bind adapters, invoke an application sentence, report status. No
 * business logic lives here or in any function body — side effects stay
 * behind the sentences; the publications ledger stays the system of
 * record (Inngest run history is telemetry, never truth).
 */
import { Inngest } from "inngest"

export const inngest = new Inngest({ id: "jps-internal" })
