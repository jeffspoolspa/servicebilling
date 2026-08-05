/**
 * TaskRoster over ION's per-customer task list.
 *
 * One call answers for ALL of a customer's tasks, which is why deletion
 * detection is affordable at all: the nightly sweep pays per customer, not per
 * task.
 *
 * Translation lives here — the port is keyed by OUR customer id, so the model
 * never learns ION's. A customer with no ion_cust_id throws rather than
 * returning empty, because "we cannot ask" must never read as "they have no
 * tasks", which would close every contract they hold.
 */
import type { TaskRoster } from "@/lib/maintenance/domain"
import type { IonTasks } from "@/lib/external/ion/ion"

interface CustomerLookup {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>
      }
    }
  }
}

export class IonTaskRoster implements TaskRoster {
  constructor(
    private readonly client: CustomerLookup,
    private readonly ion: IonTasks,
  ) {}

  async idsFor(customerId: number): Promise<Set<string>> {
    const { data, error } = await this.client
      .from("Customers").select("ion_cust_id").eq("id", customerId).maybeSingle()
    if (error) throw new Error(`roster: customer ${customerId} lookup failed: ${error.message}`)
    const ionCustId = (data as { ion_cust_id: string | null } | null)?.ion_cust_id
    if (!ionCustId) {
      throw new Error(`roster: customer ${customerId} has no ion_cust_id — cannot ask ION what they have`)
    }
    return this.ion.listTaskIds(ionCustId)
  }
}
