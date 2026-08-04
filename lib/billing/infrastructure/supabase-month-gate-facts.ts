/**
 * The month context the gate judges — bulk-loaded, one shape per customer.
 *
 * Every rule that used to hide in the SQL gate's joins is a named query here:
 *  - payment route: active autopay enrollment WITH an active payment method
 *    wins; else a customer email means a manual invoice can reach them
 *  - holds: an unreleased billing.holds row naming the customer
 *  - credits: unapplied, within six months, MAINTENANCE-marked memo only —
 *    the service gate deliberately excludes memo ~ 'maint' (those are ours),
 *    so we take exactly the complement and no credit has two owners
 *  - findings: unresolved rows on the month at blocking severity
 */

import type { MonthGateFacts } from "@/lib/billing/domain"

interface Db {
  schema(s: string): { from(t: string): Record<string, (...a: never[]) => unknown> }
  from(t: string): Record<string, (...a: never[]) => unknown>
}

type Sel = {
  select(c: string): Sel
  in(c: string, v: unknown[]): Sel
  eq(c: string, v: unknown): Sel
  is(c: string, v: null): Sel
  gt(c: string, v: unknown): Sel
  gte(c: string, v: unknown): Sel
  range(a: number, b: number): PromiseLike<{ data: unknown[] | null; error: unknown }>
}

const CHUNK = 100

export class SupabaseMonthGateFacts {
  constructor(private readonly client: Db) {}

  private q(schema: string | null, table: string): Sel {
    return (schema ? this.client.schema(schema).from(table) : this.client.from(table)) as unknown as Sel
  }

  private async chunked<T>(ids: readonly (string | number)[], fetch: (chunk: (string | number)[]) => Promise<T[]>): Promise<T[]> {
    const out: T[] = []
    for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fetch(ids.slice(i, i + CHUNK))))
    return out
  }

  /**
   * One MonthGateFacts per customer, for a whole run in ~6 chunked reads.
   * monthIdOf maps customerId -> billing_month_id for the findings lookup.
   */
  async forCustomers(customerIds: readonly number[], monthIdOf: ReadonlyMap<number, string>, now: Date): Promise<Map<number, MonthGateFacts>> {
    const custRows = await this.chunked(customerIds, async (c) => {
      const { data, error } = await this.q(null, "Customers").select("id, qbo_customer_id, email").in("id", c).range(0, 999)
      if (error) throw new Error(`customers read failed: ${JSON.stringify(error).slice(0, 200)}`)
      return (data ?? []) as { id: number; qbo_customer_id: string | null; email: string | null }[]
    })
    const qboOf = new Map(custRows.map((r) => [r.id, r.qbo_customer_id]))
    const emailOf = new Map(custRows.map((r) => [r.id, r.email]))
    const qboIds = custRows.map((r) => r.qbo_customer_id).filter((x): x is string => x !== null)

    const [autopay, methods, holds, findings] = await Promise.all([
      this.chunked(qboIds, async (c) => {
        const { data, error } = await this.q("billing", "autopay_customers").select("qbo_customer_id, is_active").in("qbo_customer_id", c).eq("is_active", true).range(0, 999)
        if (error) throw new Error(`autopay read failed: ${JSON.stringify(error).slice(0, 200)}`)
        return (data ?? []) as { qbo_customer_id: string }[]
      }),
      this.chunked(qboIds, async (c) => {
        const { data, error } = await this.q("billing", "customer_payment_methods").select("qbo_customer_id").in("qbo_customer_id", c).eq("is_active", true).range(0, 1999)
        if (error) throw new Error(`payment methods read failed: ${JSON.stringify(error).slice(0, 200)}`)
        return (data ?? []) as { qbo_customer_id: string }[]
      }),
      this.chunked(customerIds.map(String), async (c) => {
        const { data, error } = await this.q("billing", "holds").select("subject_id, reason").eq("subject_type", "customer").in("subject_id", c).is("released_at", null).range(0, 999)
        if (error) throw new Error(`holds read failed: ${JSON.stringify(error).slice(0, 200)}`)
        return (data ?? []) as { subject_id: string; reason: string | null }[]
      }),
      this.chunked([...monthIdOf.values()], async (c) => {
        const { data, error } = await this.q("billing", "findings")
          .select("billing_month_id, rule, message, severity")
          .in("billing_month_id", c).is("resolved_at", null).range(0, 1999)
        if (error) throw new Error(`findings read failed: ${JSON.stringify(error).slice(0, 200)}`)
        return (data ?? []) as { billing_month_id: string; rule: string; message: string | null; severity: string | null }[]
      }),
    ])

    const autopaySet = new Set(autopay.map((r) => r.qbo_customer_id))
    const methodSet = new Set(methods.map((r) => r.qbo_customer_id))
    const holdOf = new Map(holds.map((r) => [Number(r.subject_id), r.reason ?? "no reason recorded"]))
    const monthOfId = new Map([...monthIdOf].map(([cid, mid]) => [mid, cid]))

    const findingsOf = new Map<number, { rule: string; message: string }[]>()
    for (const r of findings) {
      if (!findingBlocks(r.rule, r.severity)) continue
      const cid = monthOfId.get(r.billing_month_id)
      if (!cid) continue
      findingsOf.set(cid, [...(findingsOf.get(cid) ?? []), { rule: r.rule, message: r.message ?? "" }])
    }

    const out = new Map<number, MonthGateFacts>()
    for (const cid of customerIds) {
      const qbo = qboOf.get(cid) ?? null
      const route = qbo && autopaySet.has(qbo) && methodSet.has(qbo)
        ? ("autopay" as const)
        : (emailOf.get(cid) ?? null)
          ? ("email" as const)
          : null
      out.set(cid, {
        qboCustomerId: qbo,
        paymentRoute: route,
        activeHold: holdOf.get(cid) ?? null,
        blockingFindings: findingsOf.get(cid) ?? [],
      })
    }
    return out
  }
}

/**
 * THE ONE INVOICE FLAG (RULED, Carter 2026-08-03): an OPEN cpv_outlier —
 * the audit's chem-per-visit judgement against the PEER GROUP — is the
 * only finding that holds a month at the gate, until a person dispositions
 * it. Everything else the old rule table named is covered structurally:
 * pricing/config/quantity errors cannot pass RECONCILE (our totals must
 * equal ION's own report), and the legacy bill-review rules were folded
 * into the peer groups themselves (customer-provides-chems IS a peer
 * group, not a rule).
 */
export function findingBlocks(rule: string, _severity: string | null): boolean {
  return rule === "cpv_outlier"
}
