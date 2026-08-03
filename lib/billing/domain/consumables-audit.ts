/**
 * The consumables audit — is any visit's chemical charge an outlier?
 *
 * Normalizes chemicals-per-visit (CPV) against two baselines and flags the
 * customer-months whose visits exceed both:
 *
 *  - the PEER GROUP: every visit of the same service type this run, because
 *    a $200 chem day on a POOL MAINTENANCE 45 means something different than
 *    on a commercial 85
 *  - SELF HISTORY: the customer's own recent median, because some pools just
 *    eat chlorine, and a customer's normal is not an outlier no matter what
 *    the peers say
 *
 * A visit must clear BOTH bars to be flagged — peers alone punish big pools,
 * self alone misses the tech who always overdoses the same customer.
 *
 * This is a domain service over rows a REPOSITORY selected and a factory
 * shaped (Evans: the repository encapsulates the criteria queries; the
 * domain judges objects, never SQL). Pure: thresholds in, findings out.
 * Findings land in billing.findings, which is exactly what the gate's
 * findings_resolved criterion reads — audit writes, gate holds.
 */

export interface ChemObservation {
  readonly monthId: string
  readonly customerId: number
  /** One serviced day of one task — the same grain labour bills at. */
  readonly visitKey: string
  readonly serviceDate: string
  /** The peer group: v_customer_peer_group's ruling for this customer. */
  readonly peerKey: string
  /** Chemicals dispensed on the visit, EXCLUDING bulk containers. */
  readonly chemCents: number
  /** Bulk-container spend on the visit (50lb buckets etc), kept apart. */
  readonly bulkCents: number
  /** The bulk items' names, for the finding's sentence. */
  readonly bulkItems: readonly string[]
}

export interface ChemHistory {
  readonly customerId: number
  /** Median chem-per-visit over the trailing window, and how many visits. */
  readonly medianChemCents: number
  readonly visits: number
}

export interface AuditPolicy {
  /** A visit above this percentile of its peer group is suspicious. */
  readonly percentile: number
  /** Peer groups smaller than this cannot define "normal". */
  readonly minPeers: number
  /** ...and it must also exceed selfFactor x the customer's own median. */
  readonly selfFactor: number
  /** Customers with fewer historical visits than this skip the self bar. */
  readonly minSelfVisits: number
  /**
   * The peer group whose TASKS are marked bulk_refill: their service
   * includes bucket deliveries, so a bulk container is expected there and a
   * mis-bill everywhere else — the tech keyed the bucket instead of the
   * single-unit item. Task attribute, set by review.
   */
  readonly bulkRefillGroup: string
  /**
   * The peer group whose tasks are marked customer_provides_chems: the
   * customer buys their own chemicals, so ANY chem billing above the
   * tolerance is a finding — no percentile involved.
   */
  readonly providerGroup: string
  /** Small incidentals a provides-chems customer may still owe for. */
  readonly providerToleranceCents: number
}

/** The house numbers. A policy object so the UI can show and change them. */
export const AUDIT_POLICY: AuditPolicy = {
  percentile: 0.95,
  minPeers: 20,
  selfFactor: 2,
  minSelfVisits: 6,
  bulkRefillGroup: "bulk_refill",
  providerGroup: "provides_chems",
  providerToleranceCents: 2500,
}

export interface AuditFinding {
  readonly monthId: string
  readonly customerId: number
  readonly rule: "cpv_outlier" | "bulk_item_misbill" | "chems_billed_to_provider"
  readonly severity: "high"
  readonly sourceKey: string
  readonly message: string
  readonly cents: number
}

const percentileOf = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return Infinity
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i]
}

/**
 * Judge one run's observations. The peer distributions are built from THIS
 * run's population, which is why the audit wants the bulk path: the whole
 * month is the peer group, in memory.
 */
export function auditConsumables(
  observations: readonly ChemObservation[],
  histories: ReadonlyMap<number, ChemHistory>,
  policy: AuditPolicy = AUDIT_POLICY,
): AuditFinding[] {
  const byPeer = new Map<string, number[]>()
  for (const o of observations) byPeer.set(o.peerKey, [...(byPeer.get(o.peerKey) ?? []), o.chemCents])
  const thresholds = new Map<string, number>()
  for (const [key, values] of byPeer) {
    if (values.length < policy.minPeers) continue // too few peers to define normal
    thresholds.set(key, percentileOf([...values].sort((a, b) => a - b), policy.percentile))
  }

  const findings: AuditFinding[] = []
  for (const o of observations) {
    // THE PROVIDER RULE. A provides-chems task should bill (almost) no
    // chemicals at all — the customer buys their own. Anything above the
    // tolerance is a finding on its face, bulk or not, and the percentile
    // machinery never touches this group.
    if (o.peerKey === policy.providerGroup) {
      const total = o.chemCents + o.bulkCents
      if (total > policy.providerToleranceCents) {
        findings.push({
          monthId: o.monthId,
          customerId: o.customerId,
          rule: "chems_billed_to_provider",
          severity: "high",
          sourceKey: o.visitKey,
          cents: total,
          message:
            `${o.serviceDate}: $${(total / 100).toFixed(2)} of chemicals billed on a visit to a ` +
            `provides-their-own-chems customer — they buy their own; anything above ` +
            `$${(policy.providerToleranceCents / 100).toFixed(2)} needs a reason`,
        })
      }
      continue
    }

    // THE BULK RULE. Bulk spend is excluded from every CPV number — a
    // legitimate delivery must not read as a chemical anomaly, and a
    // mis-keyed bucket must not poison the baselines either. Instead, a
    // bulk container on any task NOT marked bulk_refill is its own finding,
    // unconditionally: no percentile can excuse a 50lb bucket on a
    // residential pool.
    if (o.bulkCents > 0 && o.peerKey !== policy.bulkRefillGroup) {
      findings.push({
        monthId: o.monthId,
        customerId: o.customerId,
        rule: "bulk_item_misbill",
        severity: "high",
        sourceKey: o.visitKey,
        cents: o.bulkCents,
        message:
          `${o.serviceDate}: ${o.bulkItems.join(", ")} ($${(o.bulkCents / 100).toFixed(2)}) on a ` +
          `${o.peerKey} task not marked bulk_refill — was this meant to be the single-unit item? ` +
          `(if this customer genuinely gets bulk refills, mark the task and this stops firing)`,
      })
    }
    if (o.chemCents <= 0) continue
    const bar = thresholds.get(o.peerKey)
    if (bar === undefined || o.chemCents <= bar) continue

    const self = histories.get(o.customerId)
    const hasHistory = self !== undefined && self.visits >= policy.minSelfVisits
    if (hasHistory && o.chemCents <= self.medianChemCents * policy.selfFactor) continue

    findings.push({
      monthId: o.monthId,
      customerId: o.customerId,
      rule: "cpv_outlier",
      severity: "high",
      sourceKey: o.visitKey,
      cents: o.chemCents,
      message:
        `${o.serviceDate}: $${(o.chemCents / 100).toFixed(2)} of chemicals on one visit — ` +
        `above the ${Math.round(policy.percentile * 100)}th percentile of ${o.peerKey} ` +
        `($${(bar / 100).toFixed(2)})` +
        (hasHistory
          ? ` and ${(o.chemCents / Math.max(1, self.medianChemCents)).toFixed(1)}x this customer's own median ($${(self.medianChemCents / 100).toFixed(2)})`
          : ` (no self history yet — peers only)`),
    })
  }
  return findings
}
