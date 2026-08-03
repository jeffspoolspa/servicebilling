/**
 * The task repository — the missing half of TaskService.
 *
 * `TaskRepository` was declared in the domain and never implemented, so the
 * one service that persists a task could not run, and a batch path grew
 * around it that created 65 tasks in ION and recorded none of them. A port
 * without an implementation is not a seam; it is a hole.
 *
 * What it writes matches the ingester's shape exactly (`f/ION/_lib/
 * upsert_tasks.py`): one `maintenance.tasks` row per ION task, keyed 1:1 by
 * `ion_task_id` (uq_tasks_ion_task_id), plus its `task_schedules` slots. The
 * unique key is what makes this safe beside the nightly ingest — we insert
 * what we just created and verified; the ingest reconciles the same row later
 * rather than duplicating it.
 */

import type { Frequency } from "@/lib/maintenance/domain"

export interface CreatedTaskRecord {
  ionTaskId: string
  customerId: number
  /** ION's own start date for the task — the anchor for non-weekly cadences. */
  startsOn: string
  pricePerVisitCents: number | null
  billingMethod: "per_visit" | "flat_rate_monthly"
  ionInvoiceType: string | null
  slot: {
    weekday: number | null
    techEmployeeId: string | null
    frequency: Frequency
  }
}

interface Db {
  schema(s: string): {
    from(t: string): {
      insert(v: Record<string, unknown>): { select(c: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
      select(c: string): { eq(c2: string, v: unknown): { limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }> } }
    }
  }
}

export class SupabaseTaskRepository {
  constructor(private readonly client: Db) {}

  /** Our id for an ION task, if we already hold it. */
  async idOfIonTask(ionTaskId: string): Promise<string | null> {
    const { data, error } = await this.client
      .schema("maintenance")
      .from("tasks")
      .select("id")
      .eq("ion_task_id", ionTaskId)
      .limit(1)
    if (error) throw new Error(`task lookup failed: ${JSON.stringify(error).slice(0, 200)}`)
    return ((data ?? [])[0] as { id: string } | undefined)?.id ?? null
  }

  /**
   * Record a task we just created and READ BACK from ION. Idempotent by the
   * ion_task_id key: a second call finds the row and writes nothing.
   */
  async recordCreated(r: CreatedTaskRecord): Promise<{ taskId: string; created: boolean }> {
    const existing = await this.idOfIonTask(r.ionTaskId)
    if (existing) return { taskId: existing, created: false }

    const { data, error } = await this.client
      .schema("maintenance")
      .from("tasks")
      .insert({
        ion_task_id: r.ionTaskId,
        customer_id: r.customerId,
        status: "active",
        starts_on: r.startsOn,
        billing_method: r.billingMethod,
        price_per_visit_cents: r.pricePerVisitCents,
        ion_invoice_type: r.ionInvoiceType,
        external_source: "app_task_create",
      })
      .select("id")
    if (error) throw new Error(`task insert failed for ION ${r.ionTaskId}: ${JSON.stringify(error).slice(0, 240)}`)
    const taskId = ((data ?? [])[0] as { id: string } | undefined)?.id
    if (!taskId) throw new Error(`task insert touched NO rows for ION ${r.ionTaskId} — filtered, not applied`)

    const { data: slotRows, error: slotErr } = await this.client
      .schema("maintenance")
      .from("task_schedules")
      .insert({
        task_id: taskId,
        ion_task_id: r.ionTaskId,
        day_of_week: r.slot.weekday,
        tech_employee_id: r.slot.techEmployeeId,
        frequency: r.slot.frequency,
        active: true,
        starts_on: r.startsOn,
        external_source: "app_task_create",
      })
      .select("id")
    if (slotErr) throw new Error(`slot insert failed for ION ${r.ionTaskId}: ${JSON.stringify(slotErr).slice(0, 240)}`)
    if (!slotRows || slotRows.length === 0) {
      throw new Error(`slot insert touched NO rows for ION ${r.ionTaskId} — filtered, not applied`)
    }
    return { taskId, created: true }
  }
}
