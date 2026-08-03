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

import { IonTaskAcl } from "@/lib/external/ion/acl"
import { startsOnFor } from "@/lib/external/ion/acl"
import type { IonTasks } from "@/lib/external/ion/ion"
import type { SupabaseCustomerRepository } from "@/lib/customers/infrastructure/supabase-customer-repository"

export interface TaskToOpen {
  accountId: number
  displayName: string
  frequency: "weekly" | "biweekly_a" | "biweekly_b" | "monthly"
  weekday: number
  ratePerVisit: number | null
  poolType: string
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
    private readonly customers: SupabaseCustomerRepository,
    private readonly ion: IonTasks,
    private readonly acl: IonTaskAcl,
  ) {}

  async open(
    tasks: TaskToOpen[],
    opts: { ionTech: string; template: Record<string, string>; notBefore: string; dryRun: boolean },
  ): Promise<OpenedTask[]> {
    const linked = await this.customers.linkedOf(tasks.map((t) => t.accountId))
    const out: OpenedTask[] = []
    for (const t of tasks) {
      const link = linked.get(t.accountId)
      if (!link) {
        out.push({ accountId: t.accountId, displayName: t.displayName, accepted: false, detail: "ION ref not linked — task creation is blocked until it is" })
        continue
      }
      const startsOn = startsOnFor(t.frequency, t.weekday, opts.notBefore)
      const create = this.acl.toIonCreate(
        { frequency: t.frequency, weekday: t.weekday, startsOn, ratePerVisit: t.ratePerVisit, poolType: t.poolType, note: t.note },
        { ionCustId: link.ionCustId, ionTech: opts.ionTech },
        opts.template,
      )
      try {
        const r = await this.ion.createTask(create, { dryRun: opts.dryRun })
        out.push({ accountId: t.accountId, displayName: t.displayName, accepted: r.accepted, ionTaskId: r.ionTaskId, detail: r.detail })
      } catch (err) {
        out.push({ accountId: t.accountId, displayName: t.displayName, accepted: false, detail: err instanceof Error ? err.message : String(err) })
      }
    }
    return out
  }
}
