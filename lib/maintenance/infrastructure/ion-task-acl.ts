/**
 * The maintenance module's ANTICORRUPTION LAYER for opening ION tasks.
 *
 * Two jobs, both translation and neither policy:
 *  - encode the domain's BillingTerms (two axes) as ION's single InvoiceType
 *  - encode a rate and a pool type as ION's catalog ids
 *
 * The DECISIONS are the domain's (BillingTerms, the agreed rate); only their
 * spelling in ION's vocabulary lives here. Nothing above this file may know
 * that "6" means anything.
 */

/**
 * ION's InvoiceType is a single number encoding BOTH of our billing axes.
 * Translating our two decisions into that one number is exactly this layer's
 * job — nothing above here may know that 6 means anything.
 *
 * Read straight off ION's own option list (probed 2026-08-03):
 *   1  Flat Rate (separate consumables)      6  Per Visit Itemized (separate consumables)
 *   2  Flat Rate (list consumables)          9  Per Visit Itemized (list consumables)
 *
 * "list consumables" is ION's phrase for chemicals appearing on the service
 * invoice rather than being charged on their own — our `included`.
 */
const INVOICE_TYPE: Record<string, string> = {
  "per_visit|separate": "6",
  "per_visit|included": "9",
  "flat_rate|separate": "1",
  "flat_rate|included": "2",
}

export function invoiceTypeFor(billing: { labor: string; consumables: string }): string {
  const code = INVOICE_TYPE[`${billing.labor}|${billing.consumables}`]
  if (!code) throw new Error(`no ION InvoiceType for ${billing.labor} labor with ${billing.consumables} consumables`)
  return code
}

/**
 * The house rules for a residential maintenance task, resolved from the
 * pool's own facts (Carter, 2026-08-03):
 *  - ServiceType comes from the PRICE LADDER (POOL MAINTENANCE 35..90, one
 *    per rate) — never the itemcost override when a rung exists. itemcost
 *    stays only for off-ladder rates (and spas, whose service type is $0).
 *  - The cleaning profile follows the sanitizer: salt -> RESIDENTIAL
 *    CLEANING SALT POOL, tablet/chlorine -> TABLET, spa -> CHLORINE SPA.
 *  - Billing comes from the DOMAIN's two axes, encoded by invoiceTypeFor.
 */
const MAINT_LADDER: Record<string, string> = {
  "35": "690630", "40": "690631", "45": "690632", "50": "690633", "55": "690634",
  "60": "690635", "65": "690636", "70": "690628", "75": "690629", "80": "1200602",
  "85": "1428955", "90": "1606389",
}
const PROFILE = { salt: "3347", tablet: "3348", spa: "10524" }
const SPA_CLEAN = "690644"

export function maintenanceDefaults(pool: {
  poolType: string
  ratePerVisit: number | null
  billing: { labor: string; consumables: string }
}): { fields: Record<string, string>; advisories: string[] } {
  const advisories: string[] = []
  const t = pool.poolType.toLowerCase()
  const isSpa = t.includes("spa") && !t.includes("pool")

  let profileid: string
  if (isSpa) profileid = PROFILE.spa
  else if (t.includes("salt")) profileid = PROFILE.salt
  else if (t.includes("chlorine") || t.includes("tablet") || t.includes("bromine")) profileid = PROFILE.tablet
  else {
    profileid = PROFILE.tablet
    advisories.push(`pool type "${pool.poolType}" names no sanitizer — defaulted to TABLET profile`)
  }

  const rate = pool.ratePerVisit
  const rung = rate !== null ? MAINT_LADDER[String(rate)] : undefined
  const fields: Record<string, string> = { profileid, InvoiceType: invoiceTypeFor(pool.billing) }
  if (isSpa) {
    fields.ServiceType = SPA_CLEAN
    fields.itemcost = rate !== null ? rate.toFixed(2) : ""
    advisories.push(`spa: SPA CLEAN service type prices by itemcost ($${rate ?? "?"})`)
  } else if (rung) {
    fields.ServiceType = rung
    fields.itemcost = "" // the ladder prices it; the override must NOT linger
  } else {
    fields.itemcost = rate !== null ? rate.toFixed(2) : ""
    advisories.push(`rate $${rate ?? "?"} has no POOL MAINTENANCE rung — kept itemcost override`)
  }
  return { fields, advisories }
}

const DAY_FIELD = ["day1", "day2", "day3", "day4", "day5", "day6", "day7"] as const

/** Our agreement's terms -> the fields ION's create form wants. */
export class IonTaskCreationAcl {
  /**
   * A settled agreement -> the create-form fields, over a template of the
   * send-flag radios. House defaults (price-ladder ServiceType, sanitizer
   * profile, the billing encoding) come from maintenanceDefaults; the
   * schedule fields state the cadence ION renders for this kind of task.
   */
  toIonCreate(
    c: {
      frequency: string
      weekday: number
      startsOn: string
      ratePerVisit: number | null
      poolType: string
      billing: { labor: string; consumables: string }
      note: string
    },
    id: { ionCustId: string; ionTech: string },
    template: Record<string, string>,
  ): { ionCustId: string; changes: Record<string, string>; expect: { serviceRepeat: string; startsOn: string } } {
    const serviceRepeat = c.frequency === "weekly" ? "2" : c.frequency.startsWith("biweekly") ? "3" : "4"
    const changes: Record<string, string> = {
      ...template,
      ...maintenanceDefaults({ poolType: c.poolType, ratePerVisit: c.ratePerVisit, billing: c.billing }).fields,
      ServiceRepeat: serviceRepeat,
      StartsOn: c.startsOn,
      AssignedTo: id.ionTech,
    }
    // ION's field is LOWERCASE; sending TaskNote as well made ColdFusion
    // comma-join the two values into garbage on 65 live tasks.
    if (c.note) changes["tasknote"] = c.note.slice(0, 900)
    // Only a day-picker cadence states a weekday; the rest carry it in StartsOn.
    if (serviceRepeat === "2") changes[DAY_FIELD[c.weekday]] = id.ionTech
    return { ionCustId: id.ionCustId, changes, expect: { serviceRepeat, startsOn: c.startsOn } }
  }
}
