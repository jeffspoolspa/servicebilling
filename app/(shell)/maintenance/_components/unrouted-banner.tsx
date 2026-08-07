import { listUnroutedCustomers } from "../_lib/views"
import { UnroutedBannerView } from "./unrouted-banner-view"

/**
 * Warning shown across every /maintenance/* page (rendered in the layout):
 * customers with ACTIVE tasks whose service address is unresolved can't be
 * geocoded → can't get a geographic office → can't be placed on a route.
 * One compact collapsible line; each chip links to the customer page,
 * where the in-app address editor resolves it (ADR 007). Renders nothing
 * when everything is routable.
 */
export async function UnroutedBanner() {
  const rows = await listUnroutedCustomers()
  if (rows.length === 0) return null
  return <UnroutedBannerView rows={rows} />
}
