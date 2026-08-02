/**
 * Delivery channels — the plugs for the domain's DeliveryChannel outlet.
 * Both wrap existing Windmill comms scripts (f/comms/send_email, send_sms);
 * nothing here decides anything, per the layering contract.
 */
import type { DeliveryChannel, Invoice } from "@/lib/domain/billing"

async function runScript(token: string, path: string, args: Record<string, unknown>): Promise<void> {
  const r = await fetch(
    `https://app.windmill.dev/api/w/jps-internal/jobs/run_wait_result/p/${path}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    },
  )
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
}

export class EmailChannel implements DeliveryChannel {
  readonly kind = "email" as const
  constructor(private readonly token: string) {}

  async deliver(invoice: Invoice, to: string, attachmentUrl?: string): Promise<void> {
    await runScript(this.token, "f/comms/send_email", {
      to,
      subject: `Jeff's Pool & Spa — ${invoice.kind} invoice, ${invoice.month.slice(0, 7)}`,
      body: `Your ${invoice.kind} invoice for ${invoice.month.slice(0, 7)} is ready.` +
        (attachmentUrl ? `\n\n${attachmentUrl}` : ""),
    })
  }
}

export class SmsChannel implements DeliveryChannel {
  readonly kind = "sms" as const
  constructor(private readonly token: string) {}

  async deliver(invoice: Invoice, to: string, attachmentUrl?: string): Promise<void> {
    await runScript(this.token, "f/comms/send_sms", {
      to,
      body: `Jeff's Pool & Spa: your ${invoice.month.slice(0, 7)} invoice is ready.` +
        (attachmentUrl ? ` ${attachmentUrl}` : ""),
    })
  }
}
