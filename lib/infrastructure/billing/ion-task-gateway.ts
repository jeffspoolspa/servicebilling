/**
 * ION task-config gateway — reads ONE task's config directly from ION via the
 * Windmill script f/ION/api/get_task_detail, independent of the active roster.
 *
 * This exists because the roster sync (f/ION/recurring_tasks) can only see
 * ACTIVE tasks: a rate change made in the same edit as an expiry leaves the
 * roster carrying its new price and is never captured (the Winters case).
 * Billing verifies config here instead of trusting the roster.
 */
import { laborPolicyFor, consumablesPolicyFor } from "@/lib/domain/billing"
import type { ConsumablesPolicyKey, LaborPolicyKey } from "@/lib/domain/billing"

export interface IonTaskDetail {
  readonly ionTaskId: string
  readonly invoiceType: string | null
  readonly laborKey: LaborPolicyKey
  readonly consumablesKey: ConsumablesPolicyKey
  readonly priceCents: number | null
  readonly startsOn: string | null
  readonly endsOn: string | null
}

/**
 * The anti-corruption parse: ION's single "Invoice Type" string carries two
 * independent decisions. Kept here at the boundary so the domain never sees
 * ION's vocabulary. Robust to combinations we have not met yet.
 */
export function parseInvoiceType(raw: string | null | undefined): {
  laborKey: LaborPolicyKey
  consumablesKey: ConsumablesPolicyKey
} {
  const s = (raw ?? "").toLowerCase()
  const laborKey: LaborPolicyKey = s.includes("do not invoice")
    ? "do_not_invoice"
    : s.includes("flat rate")
      ? "flat_rate_monthly"
      : "per_visit"
  const consumablesKey: ConsumablesPolicyKey = s.includes("separate consumables") ? "separate" : "listed"
  return { laborKey, consumablesKey }
}

const asCents = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

const asDate = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : ""
  if (!s) return null
  const us = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) // ION renders mm/dd/yyyy
  if (us) return `${us[3]}-${us[1]}-${us[2]}`
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

export class WindmillIonTaskGateway {
  constructor(
    private readonly token: string,
    private readonly workspace = "jps-internal",
    private readonly base = "https://app.windmill.dev",
  ) {}

  /** Read one task's live config from ION. Throws on job failure. */
  async detail(ionTaskId: string, ionCustId = ""): Promise<IonTaskDetail> {
    const run = await fetch(
      `${this.base}/api/w/${this.workspace}/jobs/run_wait_result/p/f/ION/api/get_task_detail?tag=chromium`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ionTaskId, ionCustId }),
      },
    )
    if (!run.ok) throw new Error(`get_task_detail ${ionTaskId}: ${run.status} ${await run.text()}`)
    const raw = (await run.json()) as { detail?: Record<string, unknown> }
    const d = raw.detail
    if (!d) throw new Error(`get_task_detail ${ionTaskId}: no detail in response`)

    // ION returns enums as { text, value }; dates already ISO.
    const enumText = (v: unknown): string | null =>
      v && typeof v === "object" && "text" in (v as Record<string, unknown>)
        ? String((v as { text: unknown }).text)
        : typeof v === "string"
          ? v
          : null

    const invoiceType = enumText(d.invoiceType)
    const { laborKey, consumablesKey } = parseInvoiceType(invoiceType)
    return {
      ionTaskId: String(ionTaskId),
      invoiceType,
      laborKey,
      consumablesKey,
      priceCents: asCents(d.itemCost),
      startsOn: asDate(d.startsOn),
      endsOn: asDate(d.endsOn),
    }
  }

  /** Verify our stored policies against ION for one task. */
  agreesWith(
    detail: IonTaskDetail,
    ours: { laborKey: string; consumablesKey: string; perVisitCents: number; flatMonthlyCents: number },
  ): boolean {
    if (detail.laborKey !== ours.laborKey) return false
    if (detail.consumablesKey !== ours.consumablesKey) return false
    if (detail.priceCents === null) return true // ION uses the service-type default
    const oursCents =
      laborPolicyFor(ours.laborKey).key === "flat_rate_monthly" ? ours.flatMonthlyCents : ours.perVisitCents
    return detail.priceCents === oursCents && consumablesPolicyFor(ours.consumablesKey).key === detail.consumablesKey
  }
}
