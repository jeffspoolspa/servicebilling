/**
 * ScenarioRepository over maintenance.scenarios.
 *
 * Stores the change list, never the stops it implies — a scenario's identity
 * is its changes, and the stops are recomputed against the live plan on open
 * (Scenario.restore invalidates whatever the world moved out from under).
 */

import type { RoutingEvent, ScenarioRepository, StoredScenario } from "@/lib/domain/routing"

interface ScenarioQuery {
  select(columns: string): ScenarioQuery
  insert(values: Record<string, unknown>): ScenarioQuery
  update(values: Record<string, unknown>): ScenarioQuery
  eq(column: string, value: unknown): ScenarioQuery
  order(column: string, opts: { ascending: boolean }): ScenarioQuery
  single(): PromiseLike<{ data: unknown; error: unknown }>
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>
  then<T>(onfulfilled: (value: { data: unknown[] | null; error: unknown }) => T): PromiseLike<T>
}

export interface ScenarioClient {
  schema(name: string): { from(table: string): ScenarioQuery }
}

interface Row {
  id: string
  name: string
  status: StoredScenario["status"]
  changes: RoutingEvent[]
  created_at: string
  updated_at: string
}

const toStored = (r: Row): StoredScenario => ({
  id: r.id,
  name: r.name,
  status: r.status,
  changes: r.changes ?? [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class SupabaseScenarioRepository implements ScenarioRepository {
  constructor(private readonly client: ScenarioClient) {}

  private table(): ScenarioQuery {
    return this.client.schema("maintenance").from("scenarios")
  }

  async list(status?: StoredScenario["status"]): Promise<StoredScenario[]> {
    let q = this.table().select("*").order("updated_at", { ascending: false })
    if (status) q = q.eq("status", status)
    const { data, error } = await q
    if (error) throw new Error(`scenarios list: ${JSON.stringify(error)}`)
    return ((data ?? []) as Row[]).map(toStored)
  }

  async byId(id: string): Promise<StoredScenario | null> {
    const { data, error } = await this.table().select("*").eq("id", id).maybeSingle()
    if (error) throw new Error(`scenarios byId: ${JSON.stringify(error)}`)
    return data ? toStored(data as Row) : null
  }

  async create(name: string, changes: readonly RoutingEvent[]): Promise<StoredScenario> {
    const { data, error } = await this.table()
      .insert({ name, changes: changes as unknown })
      .select("*")
      .single()
    if (error) throw new Error(`scenarios create: ${JSON.stringify(error)}`)
    return toStored(data as Row)
  }

  async update(
    id: string,
    patch: Partial<Pick<StoredScenario, "name" | "changes" | "status">>,
  ): Promise<void> {
    const values: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (patch.name !== undefined) values.name = patch.name
    if (patch.changes !== undefined) values.changes = patch.changes
    if (patch.status !== undefined) values.status = patch.status
    const { error } = await this.table().update(values).eq("id", id).select("id").single()
    if (error) throw new Error(`scenarios update: ${JSON.stringify(error)}`)
  }
}
