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
  /**
   * The peer group. The task's chem provision (bulk_refill,
   * provides_chems) overrides the customer's demographic group
   * (v_customer_peer_group) — RULED (Carter, 2026-08-03): provisions are
   * PEER GROUPS, not special rules. A 50lb bucket on a bulk_refill task is
   * unremarkable inside its own group's distribution; the same bucket on a
   * weekly residential pool blows past that group's percentile and flags —
   * one rule covers both.
   */
  readonly peerKey: string
  /** ALL chemicals billed on the visit, buckets included. */
  readonly chemCents: number
}

export interface ChemHistory {
  readonly customerId: number
  /** Median chem-per-visit over the trailing window, and how many visits. */
  readonly medianChemCents: number
  /** The customer's OWN 95th-percentile visit over the window. */
  readonly p95ChemCents: number
  readonly visits: number
}

export interface AuditPolicy {
  /** A visit above this percentile of its peer group is suspicious. */
  readonly percentile: number
  /** Peer groups smaller than this cannot define "normal". */
  readonly minPeers: number
  /** RETIRED (Carter 2026-08-04): superseded by the self-percentile rule —
   *  kept for display context only. */
  readonly selfFactor: number
  /** RULED: the SELF bar (own p95) applies only with enough history to
   *  justify a distribution — this many of the customer's own visits. */
  readonly minSelfVisits: number
  /**
   * Peer groups the CPV check does NOT judge (RULED: Carter, 2026-08-03).
   * bulk_refill only: its spend is deliveries, not per-visit usage, so a
   * percentile says nothing useful. provides_chems IS judged — against its
   * own group's distribution, where "normal" is the small incidental spend
   * of customers who buy their own chemicals. Exempt groups still form
   * their own peer group, keeping their spend OUT of everyone else's
   * baselines.
   */
  readonly cpvExemptGroups: readonly string[]
}

/** The house numbers. A policy object so the UI can show and change them. */
export const AUDIT_POLICY: AuditPolicy = {
  percentile: 0.95,
  minPeers: 20,
  selfFactor: 2,
  minSelfVisits: 20,
  cpvExemptGroups: ["bulk_refill"],
}

export interface AuditFinding {
  readonly monthId: string
  readonly customerId: number
  readonly rule: "cpv_outlier"
  readonly severity: "high"
  readonly sourceKey: string
  readonly message: string
  readonly cents: number
}

/** One pool's bar, read from the published surface (billing.v_peer_group_bars). */
export interface PeerBar {
  readonly p95ChemCents: number
  readonly visits: number
}

/**
 * Judge one run's observations against the PUBLISHED bars (RULED
 * 2026-08-05): the distributions are a read surface — one row per pool,
 * always current as visits land — and the domain keeps only the POLICY:
 * which pools are exempt, how many peers define "normal", when the self
 * bar applies, and the comparison itself.
 */
export function auditConsumables(
  observations: readonly ChemObservation[],
  histories: ReadonlyMap<number, ChemHistory>,
  bars: ReadonlyMap<string, PeerBar>,
  policy: AuditPolicy = AUDIT_POLICY,
): AuditFinding[] {
  const exempt = new Set(policy.cpvExemptGroups)

  const findings: AuditFinding[] = []
  for (const o of observations) {
    if (exempt.has(o.peerKey)) continue
    if (o.chemCents <= 0) continue

    // RULED (Carter, 2026-08-04): flagged = the visit's consumable total at
    // or above the PEER group's 95th percentile, OR at or above the
    // customer's OWN 95th percentile when they have the history to justify
    // a distribution (minSelfVisits of their own visits).
    const bar = bars.get(o.peerKey)
    const peerBar = bar !== undefined && bar.visits >= policy.minPeers ? bar.p95ChemCents : undefined
    const self = histories.get(o.customerId)
    const selfBar = self !== undefined && self.visits >= policy.minSelfVisits ? self.p95ChemCents : undefined
    const overPeer = peerBar !== undefined && o.chemCents > peerBar
    const overSelf = selfBar !== undefined && o.chemCents > selfBar
    if (!overPeer && !overSelf) continue

    const reasons: string[] = []
    if (overPeer) reasons.push(`above the ${Math.round(policy.percentile * 100)}th percentile of ${o.peerKey} ($${(peerBar! / 100).toFixed(2)})`)
    if (overSelf) reasons.push(`above their own ${Math.round(policy.percentile * 100)}th percentile ($${(selfBar! / 100).toFixed(2)}, ${self!.visits} visits)`)

    findings.push({
      monthId: o.monthId,
      customerId: o.customerId,
      rule: "cpv_outlier",
      severity: "high",
      sourceKey: o.visitKey,
      cents: o.chemCents,
      message: `${o.serviceDate}: $${(o.chemCents / 100).toFixed(2)} of chemicals on one visit — ${reasons.join(" and ")}`,
    })
  }
  return findings
}
