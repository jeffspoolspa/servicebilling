import type { DocLine, InvoiceDocument } from "@/lib/billing/domain"

/**
 * LABOR SKU RESOLUTION — every labor line resolves to its real QBO Service
 * item from maintenance.labor_items (the catalog seeded from billed
 * history), so the document says "POOL MAINTENANCE 55", never a blank
 * service_type. The ladder, most-specific first:
 *
 *  1. exact catalog name match (visit's service_type already canonical)
 *  2. flat monthly line -> FLAT RATE
 *  3. the task's CATEGORY names the item (green_pool -> GREEN POOL,
 *     quality_control -> QUALITY CONTROL, one_time_clean -> ONE TIME CLEAN)
 *  4. the RATE names it (usual_rate_cents match) — rate collisions (SPA
 *     CLEAN / FOUNTAIN CLEAN / POOL MAINTENANCE 45 all $45) break on a
 *     token from the raw name, else default to POOL MAINTENANCE
 *  5. unresolved -> left as-is with qboItemId null; the draft shows the
 *     gap, the ISSUE step refuses it
 */

export interface LaborCatalogEntry {
  qboItemId: string
  usualRateCents: number | null
}

const CATEGORY_ITEM: Record<string, string> = {
  green_pool: "GREEN POOL",
  quality_control: "QUALITY CONTROL",
  one_time_clean: "ONE TIME CLEAN",
}

const TOKEN_ITEM: [RegExp, string][] = [
  [/spa/i, "SPA CLEAN"],
  [/fountain/i, "FOUNTAIN CLEAN"],
  [/salt cell/i, "SALT CELL CLEAN"],
  [/half hour/i, "HALF HOUR MAINTENANCE"],
  [/chemical test/i, "CHEMICAL TESTING"],
]

export type ResolvedLine = DocLine & { qboItemId?: string | null }

export function resolveLaborDocuments(
  documents: InvoiceDocument[],
  taskCategory: ReadonlyMap<string, string | null>,
  catalog: ReadonlyMap<string, LaborCatalogEntry>,
  /** Tasks whose TERMS say flat_rate — the flat line resolves to FLAT RATE
   *  by what the agreement IS, not by a name suffix a blank service_type
   *  can erase. */
  flatTasks: ReadonlySet<string> = new Set(),
): { documents: (Omit<InvoiceDocument, "lines"> & { lines: ResolvedLine[] })[]; unmapped: string[] } {
  const unmapped = new Set<string>()

  const resolve = (l: Extract<DocLine, { kind: "labor" | "consumable" | "variance" }>): { name: string; qboItemId: string } | null => {
    // 1 — exact
    const exact = catalog.get(l.itemName)
    if (exact) return { name: l.itemName, qboItemId: exact.qboItemId }
    // 2 — flat: the TERMS say so (name suffix kept as a fallback)
    if ((l.taskId && flatTasks.has(l.taskId) && l.serviceDate === null) || l.itemName.endsWith(" — monthly")) {
      const flat = catalog.get("FLAT RATE")
      if (flat) return { name: "FLAT RATE", qboItemId: flat.qboItemId }
    }
    // 3 — the task's category
    const cat = l.taskId ? taskCategory.get(l.taskId) : null
    const byCat = cat ? CATEGORY_ITEM[cat] : undefined
    if (byCat && catalog.has(byCat)) return { name: byCat, qboItemId: catalog.get(byCat)!.qboItemId }
    // 4 — the rate, token tiebreak, POOL MAINTENANCE default
    const candidates = [...catalog.entries()].filter(([, e]) => e.usualRateCents === l.unitPriceCents)
    if (candidates.length === 1) return { name: candidates[0][0], qboItemId: candidates[0][1].qboItemId }
    if (candidates.length > 1) {
      for (const [re, item] of TOKEN_ITEM) {
        if (re.test(l.itemName) && candidates.some(([n]) => n === item)) {
          return { name: item, qboItemId: catalog.get(item)!.qboItemId }
        }
      }
      const pool = candidates.find(([n]) => n.startsWith("POOL MAINTENANCE"))
      if (pool) return { name: pool[0], qboItemId: pool[1].qboItemId }
      return { name: candidates[0][0], qboItemId: candidates[0][1].qboItemId }
    }
    return null
  }

  const out = documents.map((d) => ({
    ...d,
    lines: d.lines.map((l): ResolvedLine => {
      if (l.kind === "visit_break" || l.kind === "consumable") return l
      const r = resolve(l)
      if (!r) {
        unmapped.add(`labor:${l.itemName || "(blank)"} @ ${l.unitPriceCents}`)
        return { ...l, qboItemId: null }
      }
      return { ...l, itemName: r.name, qboItemId: r.qboItemId }
    }),
  }))

  return { documents: out, unmapped: [...unmapped] }
}
