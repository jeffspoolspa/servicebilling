/**
 * One place that builds the routing services — used by the HTTP routes AND
 * the command line.
 *
 * The UI is not a privileged caller. Every route in app/api was assembling
 * these ports itself, and each script assembled them again, so the same
 * operation ran through four hand-written wirings; that is how task.edit and
 * publish came to choose different dates from the same rule. A second wiring
 * is a second place for behaviour to live.
 *
 * Anything that can drive the UI can now be driven from a terminal, which is
 * the point: the 20-pool change list is rehearsed and run through exactly the
 * code the button runs.
 */
import { PublishService } from "@/lib/routing/application/publish-service"
import { SupabaseTaskStore } from "@/lib/routing/infrastructure/supabase-task-store"
import { SupabaseScenarioRepository, type ScenarioClient } from "@/lib/routing/infrastructure/supabase-scenario-repository"
import { SupabaseMaintenanceEventLog } from "@/lib/maintenance/infrastructure/supabase-event-log"
import { TaskCacheRefresher } from "@/lib/maintenance/infrastructure/task-cache-refresher"
import { TaskService } from "@/lib/maintenance/application/task-service"
import { SupabaseTaskRepository } from "@/lib/maintenance/infrastructure/supabase-task-repository"
import { RefresherFreshness } from "@/lib/maintenance/infrastructure/cache-freshness"
import { IonTaskRoster } from "@/lib/maintenance/infrastructure/ion-task-roster"
import { IonTasks } from "@/lib/external/ion/ion"
import { IonTaskAcl } from "@/lib/external/ion/acl"
import type { QueryClient } from "@/lib/routing/infrastructure/supabase-quota-repository"

/** Minted however the caller can reach Windmill — HTTP route or CLI. */
export type MintSession = (forceRefresh: boolean) => Promise<unknown>

export interface RoutingServices {
  ion: IonTasks
  acl: IonTaskAcl
  publish: PublishService
  tasks: TaskService
  refresher: TaskCacheRefresher
}

/**
 * `reads` is the caller's client (a user session in a route, service-role on
 * the CLI); `writes` is always service-role — the system correcting itself.
 */
export function routingServices(
  reads: unknown,
  writes: unknown,
  mint: MintSession,
): RoutingServices {
  const ion = new IonTasks({ mint: mint as ConstructorParameters<typeof IonTasks>[0]["mint"] })
  const acl = new IonTaskAcl()
  const refresher = new TaskCacheRefresher(writes as never, ion, acl)
  const events = new SupabaseMaintenanceEventLog(
    writes as ConstructorParameters<typeof SupabaseMaintenanceEventLog>[0],
  )

  return {
    ion,
    acl,
    refresher,
    publish: new PublishService(
      new SupabaseScenarioRepository(reads as ScenarioClient),
      new SupabaseTaskStore(reads as QueryClient, writes as QueryClient, refresher),
      ion,
      acl,
      events,
    ),
    tasks: new TaskService(
      new SupabaseTaskRepository(writes as never),
      null as never,                       // refresh performs no ION write
      new RefresherFreshness(refresher),
      new IonTaskRoster(writes as never, ion),
      events,
    ),
  }
}
