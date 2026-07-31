/**
 * Territory map — the live view of the plan.
 *
 * Replaces the old page built on route-analysis.ts, which re-derived route
 * geometry in SQL alongside a second implementation in geo.ts. Everything
 * geographic here comes from the one RouteGeometry in the domain instead.
 */

import { createSupabaseServer } from "@/lib/supabase/server"
import { RoutingService } from "@/lib/application/routing/routing-service"
import {
  SupabaseQuotaRepository,
  type QueryClient,
} from "@/lib/infrastructure/routing/supabase-quota-repository"
import { listOffices, listTechBases } from "@/lib/infrastructure/routing/offices"
import { LiveMap } from "./live-map"

export const metadata = { title: "Maintenance · Territory map" }
export const dynamic = "force-dynamic"

export default async function TerritoryMapPage() {
  const supabase = await createSupabaseServer()
  const client = supabase as unknown as QueryClient
  const service = new RoutingService(new SupabaseQuotaRepository(client))

  const [snapshot, offices, baseMap] = await Promise.all([
    service.snapshot(),
    listOffices(client),
    listTechBases(client),
  ])
  const bases: Record<string, { lat: number; lng: number }> = {}
  for (const [techId, pin] of baseMap) bases[techId] = { lat: pin.lat, lng: pin.lng }
  const officeName = new Map(offices.map((o) => [o.id, o.label]))

  const ids = [
    ...new Set(
      snapshot.quotas.map((q) => q.requirement.customerId).filter((id): id is number => id !== null),
    ),
  ]
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
    .select("id, first_name, last_name, branch_id")
    .range(0, 999)
  const techs: Record<string, string> = {}
  const techOffices: Record<string, string | null> = {}
  for (const t of employees ?? []) {
    techs[t.id as string] = `${t.first_name ?? ""} ${t.last_name ?? ""}`.trim()
    techOffices[t.id as string] = officeName.get(t.branch_id as string) ?? null
  }

  return (
    <LiveMap
      token={process.env.MAPBOX_TOKEN ?? null}
      week={snapshot.week}
      quotas={snapshot.quotas}
      offices={offices}
      bases={bases}
      customers={customers}
      techs={techs}
      techOffices={techOffices}
    />
  )
}
