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

import { Task, type Frequency, type Slot, type TaskEvent, type TaskRepository, type Terms } from "@/lib/maintenance/domain"

const TASK_COLS =
  "id, customer_id, ion_task_id, status, starts_on, ends_on, billing_method, price_per_visit_cents, notes, ion_invoice_type"

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
      select(c: string): {
        eq(c2: string, v: unknown): {
          limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown }>
          order(c3: string, o: { ascending: boolean }): PromiseLike<{ data: unknown[] | null; error: unknown }>
        }
      }
      update(v: Record<string, unknown>): {
        eq(c2: string, v2: unknown): { select(c3: string): PromiseLike<{ data: unknown[] | null; error: unknown }> }
      }
    }
  }
}

interface TaskRow {
  id: string
  customer_id: number
  ion_task_id: string | null
  status: string
  starts_on: string | null
  ends_on: string | null
  billing_method: string | null
  price_per_visit_cents: number | null
  notes: string | null
  ion_invoice_type: string | null
}

interface SlotRow {
  day_of_week: number | null
  tech_employee_id: string | null
  frequency: string | null
  active: boolean
}

export class SupabaseTaskRepository implements TaskRepository {
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

  /* ------------------------- the TaskRepository port ------------------------ */

  /** Reconstitute one task with its slots. Rows in, aggregate out. */
  async byId(taskId: string): Promise<Task | null> {
    const { data, error } = await this.client.schema("maintenance").from("tasks").select(TASK_COLS).eq("id", taskId).limit(1)
    if (error) throw new Error(`task read failed: ${JSON.stringify(error).slice(0, 200)}`)
    const row = (data ?? [])[0] as TaskRow | undefined
    if (!row) return null

    const { data: slotData, error: slotErr } = await this.client
      .schema("maintenance").from("task_schedules")
      .select("day_of_week, tech_employee_id, frequency, active")
      .eq("task_id", taskId)
      .order("day_of_week", { ascending: true })
    if (slotErr) throw new Error(`slot read failed: ${JSON.stringify(slotErr).slice(0, 200)}`)

    const slots: Slot[] = ((slotData ?? []) as SlotRow[])
      .filter((s2) => s2.active && s2.day_of_week !== null)
      .map((s2) => ({ weekday: s2.day_of_week as Slot["weekday"], techId: s2.tech_employee_id, frequency: (s2.frequency ?? "weekly") as Frequency }))

    const terms: Terms = {
      billingMethod: (row.billing_method === "flat_rate_monthly" ? "flat_rate_monthly" : "per_visit"),
      priceCents: row.price_per_visit_cents,
      serviceTypeId: "",
      startsOn: row.starts_on ?? "1970-01-01",
      endsOn: row.ends_on,
      slots,
      note: row.notes ?? undefined,
    }
    const status = row.status === "paused" ? "paused" : row.status === "closed" ? "closed" : "active"
    return Task.rehydrate(row.id, row.customer_id, row.ion_task_id, terms, status)
  }

  async openTaskFor(customerId: number): Promise<Task | null> {
    const { data, error } = await this.client.schema("maintenance").from("tasks").select("id, status").eq("customer_id", customerId).limit(50)
    if (error) throw new Error(`open-task lookup failed: ${JSON.stringify(error).slice(0, 200)}`)
    const open = ((data ?? []) as { id: string; status: string }[]).find((r) => r.status === "active" || r.status === "paused")
    return open ? this.byId(open.id) : null
  }

  /**
   * Persist an EDITED task and its facts. Called only after ION accepted and
   * the write was read back — our cache records what the system of record
   * confirmed, never what we hoped it would do.
   */
  async save(task: Task): Promise<void> {
    if (!task.id) throw new Error("cannot save a task with no id — add it first")
    const t = task.terms
    const { data, error } = await this.client
      .schema("maintenance").from("tasks")
      .update({
        billing_method: t.billingMethod,
        price_per_visit_cents: t.priceCents,
        starts_on: t.startsOn,
        ends_on: t.endsOn,
        notes: t.note ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", task.id)
      .select("id")
    if (error) throw new Error(`task save failed: ${JSON.stringify(error).slice(0, 240)}`)
    if (!data || data.length === 0) {
      throw new Error(`task save touched NO rows (${task.id}) — the write was filtered, not applied`)
    }

    // Slots: the desired week is complete, so a day the task no longer serves
    // must be deactivated, not merely left behind.
    await this.syncSlots(task as Task & { id: string })

    for (const fact of task.pullEvents()) await this.appendFact(fact)
  }

  async history(taskId: string): Promise<TaskEvent[]> {
    const { data, error } = await this.client
      .schema("maintenance").from("events")
      .select("type, aggregate_id, occurred_at, payload")
      .eq("aggregate_id", taskId)
      .order("occurred_at", { ascending: true })
    if (error) throw new Error(`task history read failed: ${JSON.stringify(error).slice(0, 200)}`)
    return ((data ?? []) as { type: string; aggregate_id: string; occurred_at: string; payload: Record<string, unknown> }[]).map((r) => ({
      type: r.type as TaskEvent["type"],
      taskId: r.aggregate_id,
      at: r.occurred_at,
      payload: r.payload ?? {},
    }))
  }

  private async syncSlots(task: Task & { id: string }): Promise<void> {
    const want = new Map(task.terms.slots.map((s2) => [s2.weekday, s2]))
    const { data, error } = await this.client
      .schema("maintenance").from("task_schedules")
      .select("id, day_of_week, tech_employee_id, frequency, active")
      .eq("task_id", task.id)
      .order("day_of_week", { ascending: true })
    if (error) throw new Error(`slot read failed: ${JSON.stringify(error).slice(0, 200)}`)

    const have = (data ?? []) as (SlotRow & { id: string })[]
    for (const row of have) {
      const wanted = row.day_of_week === null ? undefined : want.get(row.day_of_week as Slot["weekday"])
      if (!wanted && row.active) await this.patchSlot(row.id, { active: false })
      else if (wanted && (!row.active || row.tech_employee_id !== wanted.techId || row.frequency !== wanted.frequency)) {
        await this.patchSlot(row.id, { active: true, tech_employee_id: wanted.techId, frequency: wanted.frequency })
      }
      if (row.day_of_week !== null) want.delete(row.day_of_week as Slot["weekday"])
    }
    for (const [, s2] of want) {
      await this.recordSlot(task.id, task.ionTaskId ?? "", s2, task.terms.startsOn)
    }
  }

  private async patchSlot(id: string, patch: Record<string, unknown>): Promise<void> {
    const { data, error } = await this.client
      .schema("maintenance").from("task_schedules")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id")
    if (error) throw new Error(`slot patch failed: ${JSON.stringify(error).slice(0, 200)}`)
    if (!data || data.length === 0) throw new Error(`slot patch touched NO rows (${id}) — filtered, not applied`)
  }

  private async recordSlot(taskId: string, ionTaskId: string, slot: Slot, startsOn: string): Promise<void> {
    const { data, error } = await this.client
      .schema("maintenance").from("task_schedules")
      .insert({
        task_id: taskId, ion_task_id: ionTaskId, day_of_week: slot.weekday,
        tech_employee_id: slot.techId, frequency: slot.frequency, active: true,
        starts_on: startsOn, external_source: "app_task_edit",
      })
      .select("id")
    if (error) throw new Error(`slot insert failed: ${JSON.stringify(error).slice(0, 200)}`)
    if (!data || data.length === 0) throw new Error("slot insert touched NO rows — filtered, not applied")
  }

  private async appendFact(fact: TaskEvent): Promise<void> {
    if (!fact.taskId) return // a fact minted before the id exists is the caller's bug, not ours
    const c = this.client as unknown as {
      schema(s: string): { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: unknown }> }
    }
    const { error } = await c.schema("maintenance").rpc("append_event", {
      p_aggregate: "task",
      p_aggregate_id: fact.taskId,
      p_type: fact.type,
      p_actor: "task_service",
      p_payload: fact.payload,
    })
    // History failing must never undo a landed write; it is recorded, not gating.
    if (error) console.error(`task fact ${fact.type} not appended: ${JSON.stringify(error).slice(0, 200)}`)
  }
}
