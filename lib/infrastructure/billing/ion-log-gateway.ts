/**
 * ION log editor — the plug for the domain's IonLogEditor outlet. Applies a
 * log-correction Variance to ION's record of a visit, so reality is fixed at
 * the source and re-ingest/re-accrue/re-reconcile can prove it.
 *
 * PENDING SCRIPT: the Windmill script f/ION/api/update_log_items does not
 * exist yet — it needs the ION log-edit form automated (chromium, same
 * session machinery as get_log_detail). Until it is deployed, both methods
 * throw a clear error naming it rather than pretending to succeed. The
 * application flow (applyVariance) is built and tested against the port.
 */
import type { IonLogEditor } from "@/lib/domain/billing"

const SCRIPT = "f/ION/api/update_log_items"

export class WindmillIonLogGateway implements IonLogEditor {
  constructor(
    private readonly token: string,
    private readonly base = "https://app.windmill.dev",
  ) {}

  private async run(args: Record<string, unknown>): Promise<void> {
    const r = await fetch(
      `${this.base}/api/w/jps-internal/jobs/run_wait_result/p/${SCRIPT}?tag=chromium`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      },
    )
    if (r.status === 404)
      throw new Error(`${SCRIPT} is not deployed yet — the ION log-edit automation is pending`)
    if (!r.ok) throw new Error(`${SCRIPT}: ${r.status} ${await r.text()}`)
  }

  async removeConsumable(ionLogId: string, ionItemId: string): Promise<void> {
    await this.run({ ionLogId, ionItemId, action: "remove" })
  }

  async setConsumableQuantity(ionLogId: string, ionItemId: string, quantity: number): Promise<void> {
    await this.run({ ionLogId, ionItemId, action: "set_quantity", quantity })
  }
}
