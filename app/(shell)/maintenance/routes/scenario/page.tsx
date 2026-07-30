/**
 * The scenario board: move stops between routes on the map and watch the
 * numbers move. A UI layer with no logic in it — it loads a snapshot through
 * the application service and hands it to the client, which runs the domain
 * itself.
 */

import { createSupabaseServer } from "@/lib/supabase/server"
import { RoutingService } from "@/lib/application/routing/routing-service"
import {
  SupabaseQuotaRepository,
  type QueryClient,
} from "@/lib/infrastructure/routing/supabase-quota-repository"
import { listTechBases } from "@/lib/infrastructure/routing/offices"
import { ScenarioBoard } from "./scenario-board"

export const metadata = { title: "Maintenance · Scenario board" }
export const dynamic = "force-dynamic"

export default async function ScenarioPage() {
  const supabase = await createSupabaseServer()
  const service = new RoutingService(new SupabaseQuotaRepository(supabase as unknown as QueryClient))
  const [snapshot, baseMap] = await Promise.all([
    service.snapshot(),
    listTechBases(supabase as unknown as QueryClient),
  ])
  const bases: Record<string, { lat: number; lng: number }> = {}
  for (const [techId, pin] of baseMap) bases[techId] = { lat: pin.lat, lng: pin.lng }

  const ids = [
    ...new Set(
      snapshot.quotas.map((q) => q.requirement.customerId).filter((id): id is number => id !== null),
    ),
  ]
  // Office is the customer's branch. It reaches routing as a label to filter by,
  // never as a field on the quota — no rule in the model reads it.
  const { data: branches } = await supabase.from("branches").select("id, name")
  const officeName = new Map((branches ?? []).map((b) => [b.id as string, b.name as string]))

  const customers: Record<number, { name: string; office: string | null }> = {}
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await supabase
      .from("Customers")
      .select("id, display_name, office_id")
      .in("id", ids.slice(i, i + 500))
    for (const c of data ?? []) {
      customers[c.id as number] = {
        name: (c.display_name as string) ?? "—",
        office: officeName.get(c.office_id as string) ?? null,
      }
    }
  }
  const { data: employees } = await supabase
    .from("employees")
    .select("id, first_name, last_name")
    .range(0, 999)
  const techs: Record<string, string> = {}
  for (const t of employees ?? []) {
    techs[t.id as string] = `${t.first_name ?? ""} ${t.last_name ?? ""}`.trim()
  }

  return (
    <ScenarioBoard
      token={process.env.MAPBOX_TOKEN ?? null}
      week={snapshot.week}
      quotas={snapshot.quotas}
      bases={bases}
      customers={customers}
      techs={techs}
    />
  )
}
