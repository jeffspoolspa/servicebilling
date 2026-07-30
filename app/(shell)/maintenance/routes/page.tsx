/**
 * Routes IS the territory map now — the live planning view. The old list page
 * retired 2026-07-30 (its numbers came from the pre-domain route-analysis SQL);
 * per-route detail remains at [tech]/[day].
 */
export { default, metadata } from "./map/page"
// Segment config must be declared literally — Next parses it statically.
export const dynamic = "force-dynamic"
