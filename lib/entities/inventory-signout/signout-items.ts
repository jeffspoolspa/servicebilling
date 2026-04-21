/**
 * Allowlist of items available in the maintenance tech sign-out form, with
 * optional bulk conversion.
 *
 * For items sold/tracked in a base unit (lb, oz, tab) but physically taken from
 * the warehouse by the container (bag, bucket, jug), the tech enters whole
 * containers and the server multiplies by `multiplier` before writing to
 * `inventory_sign_outs.quantity`. The stored quantity is always in the
 * item's base unit.
 *
 * Bulk items render WITHOUT a quantity input — the tech just picks the item
 * and it submits as 1 container (with multiplier applied). To sign out more
 * than one container, the tech adds another row.
 *
 * `displayName` overrides the raw items.item_name in the dropdown.
 * `category` groups items in the dropdown (order: chemicals → parts).
 */
export type SignOutCategory = "chemical" | "part"

export interface SignOutItemConfig {
  id: number
  category: SignOutCategory
  /** Overrides items.item_name in the dropdown. */
  displayName?: string
  /** e.g. 50 for a 50lb bag of a lb-tracked item. Defaults to 1. */
  multiplier?: number
  /** Singular label shown to the tech next to the quantity input. */
  inputUnit?: string
  /** Base unit stored in `inventory_sign_outs.quantity` — shown in the hint. */
  stockUnit?: string
}

/** Order drives dropdown group order. */
export const SIGNOUT_CATEGORIES: SignOutCategory[] = ["chemical", "part"]

export const SIGNOUT_CATEGORY_LABELS: Record<SignOutCategory, string> = {
  chemical: "Chemicals",
  part: "Parts",
}

export const SIGNOUT_ITEM_CONFIGS: SignOutItemConfig[] = [
  // ── Bulk chemicals: entered by container, stored in base unit (lb / oz / tab)
  { id: 13698, category: "chemical", displayName: "CAL HYPO", multiplier: 50, inputUnit: "bucket", stockUnit: "lb" },
  { id: 13703, category: "chemical", displayName: "CALCIUM CHLORIDE", multiplier: 50, inputUnit: "bag", stockUnit: "lb" },
  { id: 13735, category: "chemical", displayName: "CHLORINE TABLET", multiplier: 100, inputUnit: "bucket", stockUnit: "tab" },
  { id: 13874, category: "chemical", displayName: "CYANURIC ACID", multiplier: 25, inputUnit: "bucket", stockUnit: "lb" },
  { id: 14654, category: "chemical", displayName: "LIQUID CLARIFIER (MCB)", multiplier: 128, inputUnit: "container", stockUnit: "oz" },
  { id: 15067, category: "chemical", displayName: "PHOSPHATE REMOVER (LPE)", multiplier: 128, inputUnit: "container", stockUnit: "oz" },
  { id: 15980, category: "chemical", displayName: "SODA ASH", multiplier: 50, inputUnit: "bag", stockUnit: "lb" },
  { id: 15982, category: "chemical", displayName: "SODIUM BICARB", multiplier: 50, inputUnit: "bag", stockUnit: "lb" },

  // ── Simple chemicals: tech enters the quantity in the item's base unit
  { id: 13331, category: "chemical", displayName: "NO MOR PROBLEMS" },
  { id: 14030, category: "chemical", displayName: "ENZYME" },
  { id: 14653, category: "chemical", displayName: "LIQUID CHLORINE" },
  { id: 14797, category: "chemical", displayName: "MURIATIC ACID" },
  { id: 14934, category: "chemical", displayName: "OXIDIZER" },
  { id: 15882, category: "chemical", displayName: "SALT" },
  { id: 15883, category: "chemical", displayName: "SALT TEST STRIPS" },
  { id: 16624, category: "chemical", displayName: "TILE SOAP" },

  // ── Parts: chlorinator, polaris, psi gauges
  { id: 13729, category: "part", displayName: "CHLORINATOR CHECK VALVE" },
  { id: 13730, category: "part", displayName: "CHLORINATOR CONTROL VALVE" },
  { id: 13731, category: "part", displayName: "CHLORINATOR LID O-RING" },
  { id: 13732, category: "part", displayName: "CHLORINATOR TUBING" },
  { id: 15126, category: "part", displayName: "POLARIS ALL PURPOSE BAG" },
  { id: 15127, category: "part", displayName: "POLARIS SWEEP HOSE CLAMP" },
  { id: 15128, category: "part", displayName: "POLARIS TAIL SCRUBBER" },
  { id: 15215, category: "part", displayName: "PSI GAUGE (BACK MOUNT)" },
  { id: 15216, category: "part", displayName: "PSI GAUGE (BOTTOM MOUNT)" },
]

export const SIGNOUT_ITEM_IDS: number[] = SIGNOUT_ITEM_CONFIGS.map((c) => c.id)

export function getSignOutConfig(id: number): SignOutItemConfig | undefined {
  return SIGNOUT_ITEM_CONFIGS.find((c) => c.id === id)
}
