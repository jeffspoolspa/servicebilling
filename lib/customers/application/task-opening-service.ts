/**
 * Open recurring tasks for LINKED customers — the final leg of onboarding.
 *
 * The domain gate is absolute: a customer whose ION ref is not linked cannot
 * have a task (Customer.blocks), so this service takes the linked map from
 * the repository and refuses everyone else by name. Each create goes through
 * the ACL (our profile -> ION's create fields over a template of house
 * defaults) and the Ion object, whose proof is the task-list diff plus a
 * read-back of the new form. The cache rows arrive via the normal recurring-
 * task ingestion — this service writes nothing to our tables.
 */

import { startsOnFor } from "@/lib/external/ion/acl"
import type { IonTaskCreationAcl } from "@/lib/maintenance/infrastructure/ion-task-acl"
import type { IonTasks } from "@/lib/external/ion/ion"
import type { CustomerRepository } from "@/lib/customers/domain"
import type { SupabaseTaskRepository } from "@/lib/maintenance/infrastructure/supabase-task-repository"

import { BillingTerms } from "@/lib/maintenance/domain"

export interface TaskToOpen {
  accountId: number
  displayName: string
  frequency: "weekly" | "biweekly_a" | "biweekly_b" | "monthly"
  weekday: number
  ratePerVisit: number | null
  poolType: string
  /** The two axes. Defaults to the residential arrangement when unstated. */
  billing?: BillingTerms
  note: string
}

export interface OpenedTask {
  accountId: number
  displayName: string
  accepted: boolean
  ionTaskId?: string
  detail: string
}

export class TaskOpeningService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly ion: IonTasks,
    private readonly acl: IonTaskCreationAcl,
    /** Where a verified creation is recorded. A create ION confirms that our
     *  cache never hears about is a task nobody can route, bill, or see. */
    private readonly tasks?: SupabaseTaskRepository,
  ) {}

  async open(
    tasks: TaskToOpen[],
    opts: { ionTech: string; techEmployeeId?: string; template: Record<string, string>; notBefore: string; dryRun: boolean },
  ): Promise<OpenedTask[]> {
    const customers = await this.customers.byIds(tasks.map((t) => t.accountId))
    const out: OpenedTask[] = []
    for (const t of tasks) {
      const customer = customers.get(t.accountId)
      // The AGGREGATE decides whether a task may be opened [I-C3]; this
      // service only relays the refusal.
      const blocked = customer ? customer.blocks("create_task") : "no such customer"
      if (!customer || blocked) {
        out.push({ accountId: t.accountId, displayName: t.displayName, accepted: false, detail: blocked ?? "no such customer" })
        continue
      }
      const link = { ionCustId: (customer.ion as { id: string }).id }
      const startsOn = startsOnFor(t.frequency, t.weekday, opts.notBefore)
      const create = this.acl.toIonCreate(
        {
          frequency: t.frequency,
          weekday: t.weekday,
          startsOn,
          ratePerVisit: t.ratePerVisit,
          poolType: t.poolType,
          billing: t.billing ?? BillingTerms.residentialDefault(t.ratePerVisit),
          note: t.note,
        },
        { ionCustId: link.ionCustId, ionTech: opts.ionTech },
        opts.template,
      )
      try {
        const r = await this.ion.createTask(create, { dryRun: opts.dryRun })
        let detail = r.detail
        // Record the READ-BACK-VERIFIED creation in the same breath, the way
        // every other confirmed external write in this system does.
        if (r.accepted && r.ionTaskId && !opts.dryRun && this.tasks) {
          const rec = await this.tasks.recordCreated({
            ionTaskId: r.ionTaskId,
            customerId: t.accountId,
            startsOn,
            pricePerVisitCents: t.ratePerVisit === null ? null : Math.round(t.ratePerVisit * 100),
            billingMethod: "per_visit",
            ionInvoiceType: "Per Visit Itemized (separate consumables)",
            slot: { weekday: t.weekday, techEmployeeId: opts.techEmployeeId ?? null, frequency: t.frequency },
          })
          detail += rec.created ? ", cached" : ", already cached"
        }
        out.push({ accountId: t.accountId, displayName: t.displayName, accepted: r.accepted, ionTaskId: r.ionTaskId, detail })
      } catch (err) {
        out.push({ accountId: t.accountId, displayName: t.displayName, accepted: false, detail: err instanceof Error ? err.message : String(err) })
      }
    }
    return out
  }
}
