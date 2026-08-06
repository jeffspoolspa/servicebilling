/**
 * Billing domain self-check: `npx tsx lib/billing/domain/selfcheck.ts`
 * Pure — no database, no QBO, no ION. Every invariant gets a case that
 * PROVES it refuses, not just one that proves it allows.
 */

import assert from "node:assert"
import { chemicalsBillable, isBillable, type BillableItem, type BillableSource } from "./billable-item"
import { BillingMonth, BillingRuleError } from "./billing-month"
import { priceMonth, type PricingTerms } from "./pricer"
import { reconcile, RECONCILE_TOLERANCE_CENTS } from "./reconciler"
import { gate, type MonthGateFacts } from "./gate"
import { auditConsumables } from "./consumables-audit"
import { draftInvoice } from "./invoice-draft"
import { documentsOf, presentationOf } from "./invoice-documents"
import { invoiceNextStep } from "./invoice-lifecycle"

let n = 0
const check = (_name: string, fn: () => void) => {
  fn()
  n++
}

const AT = "2026-08-02T12:00:00Z"
const AUG = new Date("2026-08-02T09:00:00Z")
const JUL = new Date("2026-07-20T09:00:00Z")

const src = (over: Partial<BillableSource> = {}): BillableSource => ({
  sourceKind: "visit",
  sourceId: "v1",
  taskId: "t1",
  serviceDate: "2026-07-08",
  visitState: "completed",
  itemName: "POOL MAINTENANCE 65",
  qty: 1,
  itemId: null,
  unitPriceCents: null,
  claimedByMonthId: null,
  ...over,
})

const item = (over: Partial<BillableItem> = {}): BillableItem => ({
  sourceKind: "visit",
  sourceId: "v1",
  taskId: "t1",
  kind: "labor",
  serviceDate: "2026-07-08",
  itemName: "POOL MAINTENANCE 65",
  qty: 1,
  unitPriceCents: 6500,
  amountCents: 6500,
  claimedAt: AT,
  ...over,
})

const terms = (over: Partial<PricingTerms> = {}): PricingTerms => ({
  taskId: "t1",
  labor: "per_visit",
  consumables: "separate",
  amountCents: 6500,
  startsOn: "2024-04-03",
  endsOn: null,
  ...over,
})

/* --------------------------------- the rules ------------------------------ */

check("labour and chemicals part company on the same verdict", () => {
  // Labour is owed only for service performed...
  assert.strictEqual(isBillable({ visitState: "completed" }), true)
  assert.strictEqual(isBillable({ visitState: "skipped" }), false)
  assert.strictEqual(isBillable({ visitState: "non_serviceable" }), false)
  assert.strictEqual(isBillable({ visitState: "deleted" }), false)

  // ...but chemicals were bought and dispensed regardless. A gate-locked
  // visit still consumed what went in the pool; only a DELETED log did not
  // happen at all. [ruled 2026-08-03]
  assert.strictEqual(chemicalsBillable({ visitState: "completed" }), true)
  assert.strictEqual(chemicalsBillable({ visitState: "non_serviceable" }), true)
  assert.strictEqual(chemicalsBillable({ visitState: "skipped" }), true)
  assert.strictEqual(chemicalsBillable({ visitState: "deleted" }), false)
})

check("a month is the first of a month, or it is not a month", () => {
  assert.ok(BillingMonth.open("m1", 1016400, "2026-07-01") instanceof BillingMonth)
  assert.throws(() => BillingMonth.open("m1", 1016400, "2026-07-15"), BillingRuleError)
})

check("I-B1 exclusivity: a source another month holds is refused", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  assert.throws(() => m.claim(item(), { claimedByMonthId: "m-other" }, AT), /already claimed by month m-other/)

  m.claim(item(), { claimedByMonthId: null }, AT)
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.billableItems.length, 1, "the same source twice is one item")
  assert.strictEqual(m.pullFacts().length, 1, "and one fact — a re-run converges")
})

check("a month refuses what happened in another month", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  assert.throws(() => m.claim(item({ serviceDate: "2026-08-03" }), { claimedByMonthId: null }, AT), /not in 2026-07/)
})

check("re-pricing before the freeze is silent, and un-reconciles the month", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  m.markReconciled(AT)
  assert.strictEqual(m.status, "reconciled")

  m.claim(item({ amountCents: 7000, unitPriceCents: 7000 }), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.subtotalCents, 7000, "the item re-priced in place")
  assert.strictEqual(m.status, "accruing", "the sums moved, so the agreement is stale")
})

check("I-B2 completeness is a QUERY — a half-built month is legal", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  const delivered = [src(), src({ sourceId: "v2", serviceDate: "2026-07-22" }), src({ sourceId: "v3", visitState: "skipped" })]
  assert.strictEqual(m.unclaimed(delivered).length, 2, "the skipped one is not owed")
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.completenessBlockers(delivered).length, 1, "half-built is not an error")
  m.claim(item({ sourceId: "v2", serviceDate: "2026-07-22" }), { claimedByMonthId: null }, AT)
  assert.deepStrictEqual(m.completenessBlockers(delivered), [])
})

check("the calendar gates the invoice, not the accrual", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.billableFrom, "2026-08-01")
  assert.strictEqual(m.monthIsOver(new Date("2026-07-31T23:00:00Z")), false)
  assert.match(m.issueBlockers(JUL)[0], /is not over — billable from 2026-08-01/)
  assert.deepStrictEqual(m.issueBlockers(AUG), [])
})

check("nextStep is the ONE statement of the sequence", () => {
  const delivered = [src()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")

  assert.strictEqual(m.nextStep(delivered, AUG), "accrue", "nothing claimed yet")
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.nextStep(delivered, AUG), "reconcile")
  m.markReconciled(AT)
  assert.strictEqual(m.nextStep(delivered, AUG), "gate")

  // Mid-month it reconciles and gates, then PARKS rather than issuing.
  m.markGated([], AT)
  assert.strictEqual(m.nextStep(delivered, JUL), null, "waiting on the calendar")
  assert.strictEqual(m.nextStep(delivered, AUG), "issue")

  m.markInvoiced(delivered, AUG, AT)
  // RULED: the month's lifecycle ENDS at invoice creation — each invoice
  // runs its own machine; the month closes as a FOLD the read model derives.
  assert.strictEqual(m.nextStep(delivered, AUG), null, "invoiced = the month's last own step")
  assert.strictEqual(m.status, "invoiced")
})

check("a held month re-asks the gate — the hold is a snapshot, not a verdict", () => {
  const delivered = [src()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  m.markReconciled(AT)
  m.markGated(["credits_settled", "memo_present"], AT)

  assert.strictEqual(m.status, "held")
  assert.deepStrictEqual(m.heldFor, ["credits_settled", "memo_present"])
  // RULED: the gate re-computes until invoiced. A person changes the FACTS
  // (resolving findings); the machine re-asks rather than trusting the
  // stale snapshot (Debbie Romanelli: reviewed flag, Issue click no-oped).
  // The advance service stops the chain when a re-ask leaves it held.
  assert.strictEqual(m.nextStep(delivered, AUG), "gate", "held = re-ask the gate")
  assert.match(m.issueBlockers(AUG).join(" "), /held by the gate: credits_settled, memo_present/)

  // The re-ask with clean facts clears the hold and the month owes issue.
  m.markGated([], AT)
  assert.strictEqual(m.status, "gated")
  assert.strictEqual(m.nextStep(delivered, AUG), "issue")
})

check("gating before reconciling is refused — order is a rule", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.throws(() => m.markGated([], AT), /has not been reconciled/)
})

check("I-B3 the document is the freeze; before it, editing is free", () => {
  const delivered = [src()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)

  // The month is over and complete — and the ledger is STILL editable, which
  // is what makes the billing checks actionable.
  m.release("visit", "v1", AT, "the check found a bad consumable")
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.billableItems.length, 1)

  m.markReconciled(AT)
  m.markGated([], AT)
  m.markInvoiced(delivered, AUG, AT)
  assert.throws(() => m.claim(item({ sourceId: "v9" }), { claimedByMonthId: null }, AT), /record a Variance/)
  assert.throws(() => m.release("visit", "v1", AT, "too late"), /record a Variance/)

  m.pullFacts()
  m.markInvoiced(delivered, AUG, AT)
  assert.strictEqual(m.pullFacts().length, 0, "invoicing is idempotent")
})

check("a variance bridges the difference, from EITHER side, with a reason", () => {
  const delivered = [src()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  m.markReconciled(AT)
  m.markGated([], AT)

  assert.throws(
    () => m.recordVariance({ sourceId: "v1", kind: "discount", origin: "invoice", reason: "x", deltaCents: -500, techId: null }, AT),
    /no invoice yet/,
  )

  m.markInvoiced(delivered, AUG, AT)
  m.pullFacts()

  m.recordVariance({ sourceId: "v1", kind: "remove_consumable", origin: "invoice", reason: "chlorine billed twice", deltaCents: -1200, techId: "emily" }, AT)
  m.recordVariance({ sourceId: "v1", kind: "missed", origin: "visit", reason: "tech added a tab feeder after invoicing", deltaCents: 900, techId: "emily" }, AT)

  assert.strictEqual(m.varianceTotalCents, -300)
  assert.strictEqual(m.totalCents, m.subtotalCents - 300, "the bill is items plus differences")
  assert.deepStrictEqual(m.pendingAmendments().map((o) => o.needs), ["ion_log_edit", "invoice_line"])

  assert.throws(() => m.recordVariance({ sourceId: "v1", kind: "discount", origin: "invoice", reason: "  ", deltaCents: -100, techId: null }, AT), /needs a reason/)

  // Sent-ness now belongs to the invoice machine; the caller answers it.
  m.recordVariance({ sourceId: "v1", kind: "qty_correction", origin: "visit", reason: "tech logged a second bag", deltaCents: 400, techId: "emily" }, AT, { invoiceSent: true })
  assert.strictEqual(m.recordedVariances.at(-1)!.disposition, "recorded_only", "the customer already read the bill")
})

/* --------------------------------- pricing -------------------------------- */

check("per-visit labour bills each visit; consumables round ONCE", () => {
  const sources = [
    src(),
    src({ sourceId: "v2", serviceDate: "2026-07-22" }),
    src({ sourceId: "u1", sourceKind: "usage", itemName: "Chlorine Tabs", itemId: "IT-1", qty: 3 }),
  ]
  const catalog = [{ itemId: "IT-1", unitPriceCents: 433, validFrom: "2026-01-01", validTo: null }]
  const { items, refused } = priceMonth({ month: "2026-07-01", terms: terms(), sources, catalog, at: AT })
  assert.deepStrictEqual(refused, [])
  assert.strictEqual(items.filter((i) => i.kind === "labor").length, 2)
  const chem = items.find((i) => i.kind === "consumable")!
  assert.strictEqual(chem.amountCents, 1299, "3 x 433 rounded once, not per visit")
})

check("labour is charged per DAY SERVICED, not per ION log", () => {
  // A property with two bodies gets two completed logs on one day. The
  // customer agreed to a rate per visit to their pool, not per row in ION —
  // so the day bills once, and the second log is claimed at zero so no
  // delivered visit is left unowned.
  const sources = [
    src({ sourceId: "a1" }),
    src({ sourceId: "a2" }),                                   // same date
    src({ sourceId: "b1", serviceDate: "2026-07-22" }),
  ]
  const { items } = priceMonth({ month: "2026-07-01", terms: terms(), sources, catalog: [], at: AT })
  assert.strictEqual(items.length, 3, "every log is claimed")
  assert.strictEqual(items.filter((i) => i.amountCents > 0).length, 2, "but only two days are charged")
  assert.strictEqual(items.reduce((s2, i) => s2 + i.amountCents, 0), 13000)
  // Deterministic: the same log carries the charge on every re-run.
  const again = priceMonth({ month: "2026-07-01", terms: terms(), sources: [...sources].reverse(), catalog: [], at: AT })
  assert.deepStrictEqual(
    again.items.filter((i) => i.amountCents > 0).map((i) => i.sourceId).sort(),
    items.filter((i) => i.amountCents > 0).map((i) => i.sourceId).sort(),
  )
})

check("the price is the one in force WHEN ACCRUAL RUNS, not at service", () => {
  // A July visit re-accrued in August takes August's price; the freeze at
  // invoice creation is what stops it moving again.
  const sources = [src({ sourceId: "u1", sourceKind: "usage", itemName: "Tabs", itemId: "IT-1", qty: 2 })]
  const catalog = [
    { itemId: "IT-1", unitPriceCents: 400, validFrom: "2026-01-01", validTo: "2026-08-01" },
    { itemId: "IT-1", unitPriceCents: 500, validFrom: "2026-08-01", validTo: null },
  ]
  const { items } = priceMonth({ month: "2026-07-01", terms: terms(), sources, catalog, at: AT })
  assert.strictEqual(items[0].unitPriceCents, 500, "AT is 2026-08-02 — August's price")
})

check("both consumable modes CHARGE — they differ in where it appears", () => {
  // ION: "list consumables" vs "separate consumables". Caught by the July
  // shadow run: `listed` customers are billed for chemicals in the live
  // ledger, so the axis drives InvoiceType, never billability.
  const sources = [src(), src({ sourceId: "u1", sourceKind: "usage", itemName: "Chlorine Tabs", itemId: "IT-1", qty: 3 })]
  const catalog = [{ itemId: "IT-1", unitPriceCents: 433, validFrom: "2026-01-01", validTo: null }]
  for (const mode of ["included", "separate"] as const) {
    const { items } = priceMonth({ month: "2026-07-01", terms: terms({ consumables: mode }), sources, catalog, at: AT })
    assert.strictEqual(items.filter((i) => i.kind === "consumable").length, 1, `${mode} still bills the chemical`)
  }
})

check("flat rate bills the MONTH once, not each visit", () => {
  const sources = [src(), src({ sourceId: "v2", serviceDate: "2026-07-22" })]
  const { items } = priceMonth({
    month: "2026-07-01",
    terms: terms({ labor: "flat_rate", amountCents: 26000 }),
    sources, catalog: [], at: AT,
  })
  // The flat charge bills; the visits are claimed at ZERO so none is left
  // unowned — an unclaimed visit can never satisfy I-B2.
  assert.strictEqual(items.length, 3, "two visits claimed + one monthly charge")
  const flat = items.find((i) => i.sourceKind === "flat")!
  assert.strictEqual(flat.amountCents, 26000)
  assert.deepStrictEqual(items.filter((i) => i.sourceKind === "visit").map((i) => i.amountCents), [0, 0])
  assert.strictEqual(items.reduce((s2, i) => s2 + i.amountCents, 0), 26000, "the month bills the rate once")
  assert.strictEqual(flat.sourceId, "t1:2026-07", "keyed on the task-month, the thing charged once")
  assert.strictEqual(flat.serviceDate, "2026-07-22", "dated by the last visit so the charge has a date")
})

check("a deleted visit bills nothing — its chemicals included", () => {
  // Found live: a July visit deleted in ION on 2 August still had its four
  // consumables in our ledger. Filtering visits alone is not enough.
  const sources = [
    src({ sourceId: "v1" }),
    src({ sourceId: "u1", sourceKind: "usage", itemName: "Acid", itemId: "IT-1", qty: 1 }),
    src({ sourceId: "vX", visitState: "deleted" }),
    src({ sourceId: "uX", sourceKind: "usage", itemName: "Acid", itemId: "IT-1", qty: 1, visitState: "deleted" }),
  ]
  const catalog = [{ itemId: "IT-1", unitPriceCents: 1299, validFrom: "2026-01-01", validTo: null }]
  const { items } = priceMonth({ month: "2026-07-01", terms: terms(), sources, catalog, at: AT })
  assert.strictEqual(items.filter((i) => i.kind === "consumable").length, 1, "the deleted log's chemical is gone")
  assert.strictEqual(items.reduce((s2, i) => s2 + i.amountCents, 0), 6500 + 1299)

  // A gate-locked visit bills NO labour but DOES bill its chemicals —
  // WATERS AT GATEWAY, 17 July, $330.39 of shock and cal hypo.
  const gateLocked = priceMonth({
    month: "2026-07-01",
    terms: terms(),
    sources: [
      src({ sourceId: "vG", visitState: "non_serviceable" }),
      src({ sourceId: "uG", sourceKind: "usage", itemName: "Acid", itemId: "IT-1", qty: 1, visitState: "non_serviceable" }),
    ],
    catalog, at: AT,
  })
  assert.strictEqual(gateLocked.items.filter((i) => i.kind === "labor").length, 0, "no service, no labour")
  assert.strictEqual(gateLocked.items.filter((i) => i.kind === "consumable")[0].amountCents, 1299, "but the chemical was used")
})

check("a task with no price is QUALITY CONTROL — it bills at nothing", () => {
  // Ruled 2026-08-03. The visit is still claimed and its chemicals still
  // bill; only the labour is zero.
  const sources = [
    src(),
    src({ sourceId: "u1", sourceKind: "usage", itemName: "Tabs", itemId: "IT-1", qty: 2 }),
  ]
  const catalog = [{ itemId: "IT-1", unitPriceCents: 500, validFrom: "2026-01-01", validTo: null }]
  const qc = priceMonth({ month: "2026-07-01", terms: terms({ amountCents: null }), sources, catalog, at: AT })
  assert.deepStrictEqual(qc.refused, [], "a QC task is not a failure to price")
  assert.strictEqual(qc.items.find((i) => i.kind === "labor")!.amountCents, 0)
  assert.strictEqual(qc.items.find((i) => i.kind === "consumable")!.amountCents, 1000, "chemicals still bill")
})

check("a flat rate bills the FULL month, however much of it was served", () => {
  // Ruled 2026-08-03: proration is applied to the invoice as a Variance, so
  // the ledger states the contract and the reduction is an explicit act.
  // Evidence: THE LAKES (started 15 July) and SJC (ended 15 July) were each
  // billed their whole monthly rate in the live ledger.
  const started = priceMonth({
    month: "2026-07-01",
    terms: terms({ labor: "flat_rate", amountCents: 145000, startsOn: "2026-07-15" }),
    sources: [src({ serviceDate: "2026-07-22" })],
    catalog: [], at: AT,
  })
  assert.deepStrictEqual(started.refused, [])
  assert.strictEqual(started.items.find((i) => i.sourceKind === "flat")!.amountCents, 145000)

  const ended = priceMonth({
    month: "2026-07-01",
    terms: terms({ labor: "flat_rate", amountCents: 30000, endsOn: "2026-07-15" }),
    sources: [src({ serviceDate: "2026-07-08" })],
    catalog: [], at: AT,
  })
  assert.strictEqual(ended.items.find((i) => i.sourceKind === "flat")!.amountCents, 30000)
})

check("a proration is a NAMED variance, not a quietly smaller number", () => {
  const delivered = [src()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item({ amountCents: 145000, unitPriceCents: 145000 }), { claimedByMonthId: null }, AT)
  m.markReconciled(AT)
  m.markGated([], AT)
  m.markInvoiced(delivered, AUG, AT)

  m.recordVariance(
    { sourceId: null, kind: "proration", origin: "invoice", reason: "service began 15 July — 17 of 31 days", deltaCents: -65500, techId: null },
    AT,
  )
  assert.strictEqual(m.totalCents, 79500, "the contract is stated, the adjustment is visible")
  assert.strictEqual(m.pendingAmendments()[0].needs, "ion_log_edit")
})

check("what cannot be priced is REFUSED, never billed at zero", () => {
  // An unknown consumable: a zero here is invisible on the invoice and
  // permanent in the ledger, so it becomes a finding instead.
  const unknown = priceMonth({
    month: "2026-07-01",
    terms: terms(),
    sources: [src({ sourceId: "u9", sourceKind: "usage", itemName: "Mystery Jug", itemId: "IT-9", qty: 1 })],
    catalog: [{ itemId: "IT-9", unitPriceCents: 500, validFrom: "2027-01-01", validTo: null }], at: AT,
  })
  assert.strictEqual(unknown.items.length, 0)
  assert.match(unknown.refused[0].reason, /no catalogue price in force for item IT-9 .* as of 2026-08-02/)

  // A consumable with no catalogue id at all cannot be priced either.
  const noId = priceMonth({
    month: "2026-07-01",
    terms: terms(),
    sources: [src({ sourceId: "u8", sourceKind: "usage", itemName: "Loose bag", itemId: null, qty: 1 })],
    catalog: [], at: AT,
  })
  assert.match(noId.refused[0].reason, /no catalogue id to price by/)
})

/* ------------------------------ reconciliation ---------------------------- */

const reconcilable = () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)                                  // t1: 6500
  m.claim(item({ sourceId: "v2", taskId: "t2", serviceDate: "2026-07-09" }), { claimedByMonthId: null }, AT)
  return m
}

check("reconciliation is per TASK, so our grouping cannot affect the check", () => {
  const m = reconcilable()
  const r = reconcile(m, [{ taskId: "t1", totalCents: 6500 }, { taskId: "t2", totalCents: 6500 }])
  assert.strictEqual(r.agrees, true)
  assert.deepStrictEqual(r.findings, [])
})

check("rounding between two systems is not an error; a missed visit is", () => {
  const m = reconcilable()
  const close = reconcile(m, [{ taskId: "t1", totalCents: 6500 - RECONCILE_TOLERANCE_CENTS }, { taskId: "t2", totalCents: 6500 }])
  assert.strictEqual(close.agrees, true, "inside tolerance — not worth a person")

  const off = reconcile(m, [{ taskId: "t1", totalCents: 5000 }, { taskId: "t2", totalCents: 6500 }])
  assert.strictEqual(off.findings[0].rule, "task_total_mismatch")
  assert.strictEqual(off.findings[0].cents, 1500)
})

check("the three shapes of disagreement are named, not merged", () => {
  const m = reconcilable()
  // They billed a task we claimed nothing for — a delivered visit unbilled.
  const missedByUs = reconcile(m, [{ taskId: "t1", totalCents: 6500 }, { taskId: "t2", totalCents: 6500 }, { taskId: "t3", totalCents: 4000 }])
  assert.strictEqual(missedByUs.findings[0].rule, "task_not_claimed_by_us")
  assert.match(missedByUs.findings[0].message, /a delivered visit we never billed/)

  // We claimed a task they have no invoice for.
  const missedByThem = reconcile(m, [{ taskId: "t1", totalCents: 6500 }])
  assert.strictEqual(missedByThem.findings[0].rule, "task_not_billed_by_system")
})

/* ---------------------------------- the gate ------------------------------ */

const facts = (over: Partial<MonthGateFacts> = {}): MonthGateFacts => ({
  qboCustomerId: "6532",
  paymentRoute: "autopay",
  activeHold: null,
  blockingFindings: [],
  ...over,
})

/** A month in the state the gate is asked in: claimed and reconciled. */
const gateable = () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  m.markReconciled(AT)
  return m
}

check("the gate names every criterion, and says WHY it failed", () => {
  const ok = gate(gateable(), facts())
  assert.strictEqual(ok.cleared, true)
  assert.strictEqual(ok.criteria.length, 6, "all six are reported, not just failures")

  const held = gate(gateable(), facts({ qboCustomerId: null, paymentRoute: null }))
  assert.deepStrictEqual(held.heldFor, ["billing_identity", "route_resolved"])
  assert.match(held.criteria.find((c) => c.name === "route_resolved")!.detail!, /a bill could not reach them/)
  assert.match(held.criteria.find((c) => c.name === "billing_identity")!.detail!, /nobody to address an invoice to/)
})

check("the buried SQL rules become sentences a person can read", () => {
  // No credits criterion: maint in the memo IS the decision — the invoice
  // machine's credit_check applies it (see gate.ts).
  const held = gate(gateable(), facts({ activeHold: "customer asked us to pause while insurance settles" }))
  assert.deepStrictEqual(held.heldFor, ["not_on_hold"])
  assert.match(held.criteria.find((c) => c.name === "not_on_hold")!.detail!, /insurance settles/)

  const flagged = gate(gateable(), facts({ blockingFindings: [{ rule: "cpv_overcharge", message: "chems 4x peer baseline" }] }))
  assert.deepStrictEqual(flagged.heldFor, ["findings_resolved"])

  // An unreconciled month never reaches a customer — the gate defers to the
  // reconciler by reading the month itself, not a passed-in flag.
  const un = BillingMonth.open("m2", 1016400, "2026-07-01")
  un.claim(item(), { claimedByMonthId: null }, AT)
  assert.ok(gate(un, facts()).heldFor.includes("reconciled"))
})

check("a dispute buys ONE trip back to ION, then it is a person's problem", () => {
  // The usual cause of a mismatch is that our copy of delivery is stale —
  // ION deleted a log or a tech added a chemical after we last read it. So
  // the first answer is to look again, not to raise an alarm.
  const delivered = [src()]
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item(), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.nextStep(delivered, AUG), "reconcile")

  m.markDisputed(["task t1: ours $65.00 vs theirs $95.00"], AT)
  assert.strictEqual(m.status, "disputed")
  assert.strictEqual(m.nextStep(delivered, AUG), "refresh_delivery", "go and look again")

  m.markDeliveryRefreshed(AT)
  assert.strictEqual(m.deliveryWasRefreshed, true)
  assert.strictEqual(m.nextStep(delivered, AUG), "reconcile", "then try again on fresh facts")

  // A SECOND dispute is real: it stops, with its reasons, for a person.
  m.markDisputed(["task t1: still $30.00 apart"], AT)
  assert.strictEqual(m.nextStep(delivered, AUG), null, "no infinite retry")
  assert.deepStrictEqual(m.disputeReasons, ["task t1: still $30.00 apart"])

  // Agreement clears it, and the sequence resumes.
  m.markReconciled(AT)
  assert.strictEqual(m.status, "reconciled")
  assert.strictEqual(m.nextStep(delivered, AUG), "gate")
  assert.deepStrictEqual(
    m.pullFacts().map((f) => f.type),
    ["SourceClaimed", "MonthDisputed", "DeliveryRefreshed", "MonthDisputed", "MonthReconciled"],
    "every attempt is history — 'why did this month take three passes' is answerable",
  )
})

check("re-accrual REPLACES the month; a vanished source is released", () => {
  // A re-ingest gives a re-read log a new source id. Without releasing the
  // old one the month grows by the same chemicals every heal — seen live on
  // Abel, Kay: $192.99 -> $247.98 -> $302.97.
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item({ sourceKind: "usage", sourceId: "old-1", kind: "consumable", amountCents: 5499 }), { claimedByMonthId: null }, AT)
  assert.strictEqual(m.subtotalCents, 5499)

  // The same chemical comes back under a new id; the old one must go.
  m.claim(item({ sourceKind: "usage", sourceId: "new-1", kind: "consumable", amountCents: 5499 }), { claimedByMonthId: null }, AT)
  m.release("usage", "old-1", AT, "source no longer delivered — re-accrued")
  assert.strictEqual(m.subtotalCents, 5499, "one charge, not two")
  assert.deepStrictEqual(m.billableItems.map((i) => i.sourceId), ["new-1"])
})

const ob = (o: { monthId: string; customerId: number; visitKey: string; serviceDate: string; peerKey: string; chemCents: number }) => o

check("the audit flags a peer-group outlier, with the numbers in the sentence", () => {
  // The bar is a PUBLISHED SURFACE row (RULED 2026-08-05): pool p95 $10
  // over 25 visits; a $200 visit crosses it, and the customer has no
  // history, so peers alone decide.
  const bars = new Map([["weekly_residential", { p95ChemCents: 1000, visits: 25 }]])
  const obs = [ob({ monthId: "mX", customerId: 99, visitKey: "tX:2026-07-15", serviceDate: "2026-07-15", peerKey: "weekly_residential", chemCents: 20000 })]
  const f = auditConsumables(obs, new Map(), bars)
  assert.strictEqual(f.length, 1)
  assert.strictEqual(f[0].customerId, 99)
  assert.ok(f[0].message.startsWith("2026-07-15: $200.00"), "the finding leads with the date+dollars — the dedupe key and the sentence a person reads")
  assert.ok(f[0].message.includes("95th percentile"), "says WHICH bar was crossed")
})

check("the SELF bar flags on its own — and a thin history cannot", () => {
  // RULED (2026-08-04): peer OR self. $200 is UNDER this pool's $300 bar,
  // but over the customer's own p95 with real history — flags. The same
  // visit with a 2-visit history has no self distribution — silent.
  const bars = new Map([["P", { p95ChemCents: 30000, visits: 25 }]])
  const obs = [ob({ monthId: "mX", customerId: 99, visitKey: "tX:2026-07-15", serviceDate: "2026-07-15", peerKey: "P", chemCents: 20000 })]
  const history = new Map([[99, { customerId: 99, medianChemCents: 9000, p95ChemCents: 15000, visits: 21 }]])
  const f = auditConsumables(obs, history, bars)
  assert.strictEqual(f.length, 1)
  assert.ok(f[0].message.includes("their own 95th percentile"), "says the SELF bar was the one crossed")
  const thin = new Map([[99, { customerId: 99, medianChemCents: 9000, p95ChemCents: 15000, visits: 2 }]])
  assert.strictEqual(auditConsumables(obs, thin, bars).length, 0)
})

check("a peer group too small to define normal flags NOTHING", () => {
  // 3 visits is not a distribution. Flagging against it would be noise with
  // a percentile attached.
  const bars = new Map([["RARE", { p95ChemCents: 100, visits: 3 }]])
  const obs = [ob({ monthId: "c", customerId: 3, visitKey: "t3:2026-07-01", serviceDate: "2026-07-01", peerKey: "RARE", chemCents: 99999 })]
  assert.strictEqual(auditConsumables(obs, new Map(), bars).length, 0)
})

check("bulk_refill is exempt from CPV; provides_chems is judged in its OWN group", () => {
  // RULED (Carter, 2026-08-03): bulk_refill spend is deliveries — never
  // CPV-flagged. provides_chems IS CPV-judged, against its own group,
  // where normal is the small incidental spend of customers who buy their
  // own chemicals — so $80 of chems flags THERE while being unremarkable
  // among ordinary residentials. Both keep their spend out of everyone
  // else's baselines.
  const bars = new Map([
    ["bulk_refill", { p95ChemCents: 35000, visits: 25 }],
    ["provides_chems", { p95ChemCents: 500, visits: 25 }],
    ["weekly_residential", { p95ChemCents: 10000, visits: 25 }],
  ])
  const obs = [
    ob({ monthId: "bX", customerId: 200, visitKey: "tbX:2026-07-08", serviceDate: "2026-07-08", peerKey: "bulk_refill", chemCents: 160000 }),
    ob({ monthId: "pX", customerId: 201, visitKey: "tpX:2026-07-08", serviceDate: "2026-07-08", peerKey: "provides_chems", chemCents: 8000 }),
  ]
  const f = auditConsumables(obs, new Map(), bars)
  assert.deepStrictEqual(f.map((x) => x.customerId).sort(), [201], "the towering bucket stays silent; the provider's $80 flags against its own $5 normal")
})

check("the draft invoice is the ledger regrouped — regenerating IS reading", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  // Two charged visits at $65, one same-day log claimed at zero...
  m.claim(item({ sourceId: "v1", serviceDate: "2026-07-08" }), { claimedByMonthId: null }, AT)
  m.claim(item({ sourceId: "v2", serviceDate: "2026-07-15" }), { claimedByMonthId: null }, AT)
  m.claim(item({ sourceId: "v3", serviceDate: "2026-07-15", unitPriceCents: 0, amountCents: 0 }), { claimedByMonthId: null }, AT)
  // ...and four buckets of the same chemical.
  for (let i = 0; i < 4; i++) {
    m.claim(item({ sourceKind: "usage", sourceId: `u${i}`, kind: "consumable", itemName: "CHLORINE TABLET 50LB", unitPriceCents: 35000, amountCents: 35000 }), { claimedByMonthId: null }, AT)
  }
  const d = draftInvoice(m)
  assert.deepStrictEqual(
    d.lines.map((l) => [l.itemName, l.qty, l.amountCents]),
    [["POOL MAINTENANCE 65", 2, 13000], ["CHLORINE TABLET 50LB", 4, 140000]],
    "one line per item at qty, labor first — the shape the live invoices read",
  )
  assert.strictEqual(d.claimedAtZero, 1, "the collapsed log is owned, not a line")
  assert.strictEqual(d.subtotalCents, 153000)

  // Edit the ledger; the NEXT draft is the new truth — nothing to invalidate.
  m.release("usage", "u3", AT, "audit: mis-keyed bucket")
  assert.strictEqual(draftInvoice(m).subtotalCents, 118000)

  // Variances exist only once a document does (I-B3) — invoice first, then
  // an unsent variance rides the draft as its own explained line.
  const delivered = [src({ sourceId: "v1" }), src({ sourceId: "v2", serviceDate: "2026-07-15" }), src({ sourceId: "v3", serviceDate: "2026-07-15" })]
  m.markReconciled(AT)
  m.markGated([], AT)
  m.markInvoiced(delivered, AUG, AT)
  m.recordVariance({ sourceId: null, kind: "proration", origin: "visit", reason: "started mid-month", deltaCents: -49000, techId: null }, AT)
  const d3 = draftInvoice(m)
  const vline = d3.lines.find((l) => l.kind === "variance")
  assert.ok(vline && vline.detail === "started mid-month", "the edit carries its reason onto the document")
  assert.strictEqual(d3.subtotalCents, 118000 - 49000)
})

check("documents: itemized groups by visit, summary collapses, separate splits in two", () => {
  // Two visits at $65, chems on each; a second task on separate consumables.
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item({ sourceId: "v1", serviceDate: "2026-07-08" }), { claimedByMonthId: null }, AT)
  m.claim(item({ sourceId: "v2", serviceDate: "2026-07-15" }), { claimedByMonthId: null }, AT)
  m.claim(item({ sourceKind: "usage", sourceId: "u1", kind: "consumable", serviceDate: "2026-07-08", itemName: "CHLORINE TABLET", qty: 2, unitPriceCents: 699, amountCents: 1398 }), { claimedByMonthId: null }, AT)
  m.claim(item({ sourceKind: "usage", sourceId: "u2", kind: "consumable", serviceDate: "2026-07-15", itemName: "CHLORINE TABLET", qty: 3, unitPriceCents: 699, amountCents: 2097 }), { claimedByMonthId: null }, AT)
  m.claim(item({ sourceKind: "usage", sourceId: "u3", kind: "consumable", taskId: "t2", serviceDate: "2026-07-15", itemName: "MURIATIC ACID", qty: 1, unitPriceCents: 1299, amountCents: 1299 }), { claimedByMonthId: null }, AT)
  const terms = [
    { taskId: "t1", labor: "per_visit" as const, consumables: "included" as const },
    { taskId: "t2", labor: "per_visit" as const, consumables: "separate" as const },
  ]

  // ITEMIZED: break row per date, oldest first; labor then that visit's chems.
  const [svc, cons] = documentsOf(m, terms, "itemized")
  assert.deepStrictEqual(
    svc.lines.map((l) => (l.kind === "visit_break" ? `— ${l.serviceDate}` : `${l.kind}:${l.itemName}:${l.qty}`)),
    ["— 2026-07-08", "labor:POOL MAINTENANCE 65:1", "consumable:CHLORINE TABLET:2",
     "— 2026-07-15", "labor:POOL MAINTENANCE 65:1", "consumable:CHLORINE TABLET:3"],
  )
  assert.ok(cons && cons.kind === "consumables", "separate-consumables task gets its own document")
  assert.deepStrictEqual(cons.lines.map((l)=> l.kind==="visit_break" ? `— ${l.serviceDate}` : `${l.itemName}:${l.qty}`), ["— 2026-07-15", "MURIATIC ACID:1"])
  assert.strictEqual(svc.subtotalCents, 6500 + 6500 + 1398 + 2097)

  // SUMMARY: same-rate labor is ONE row qty 2; chems roll up by item.
  const [sum] = documentsOf(m, terms, "summary")
  assert.deepStrictEqual(
    sum.lines.map((l) => (l.kind === "visit_break" ? "break" : `${l.itemName}:${l.qty}:${l.amountCents}`)),
    ["POOL MAINTENANCE 65:2:13000", "CHLORINE TABLET:5:3495"],
  )

  // FLAT RATE itemized: the flat line leads at qty 1; visits break for chems only.
  const f = BillingMonth.open("m2", 8, "2026-07-01")
  f.claim(item({ sourceId: "v9", serviceDate: "2026-07-10", unitPriceCents: 0, amountCents: 0 }), { claimedByMonthId: null }, AT)
  f.claim(item({ sourceKind: "flat", sourceId: "t1:2026-07", itemName: "POOL — monthly", unitPriceCents: 30000, amountCents: 30000 }), { claimedByMonthId: null }, AT)
  f.claim(item({ sourceKind: "usage", sourceId: "u9", kind: "consumable", serviceDate: "2026-07-10", itemName: "TABS", qty: 1, unitPriceCents: 699, amountCents: 699 }), { claimedByMonthId: null }, AT)
  const [flat] = documentsOf(f, [{ taskId: "t1", labor: "flat_rate", consumables: "included" }], "itemized")
  assert.deepStrictEqual(
    flat.lines.map((l) => (l.kind === "visit_break" ? `— ${l.serviceDate}` : `${l.itemName}:${l.qty}`)),
    ["POOL — monthly:1", "— 2026-07-10", "TABS:1"],
    "flat leads at qty 1; the $0-claimed visit is a claim, not a line",
  )

  // The ACL translates ION's vocabulary; null defaults to itemized.
  assert.strictEqual(presentationOf("Per Visit Summary (list consumables)"), "summary")
  assert.strictEqual(presentationOf("Per Visit Itemized (separate consumables)"), "itemized")
  assert.strictEqual(presentationOf(null), "itemized")
})

check("QC prints at $0; a green-pool task is its OWN invoice, never combined", () => {
  const m = BillingMonth.open("m1", 1016400, "2026-07-01")
  m.claim(item({ sourceId: "v1", serviceDate: "2026-07-08" }), { claimedByMonthId: null }, AT)
  // QC visit: rate is genuinely zero — RULED: it belongs on the bill at $0.
  m.claim(item({ sourceId: "vq", taskId: "tq", serviceDate: "2026-07-10", itemName: "QUALITY CONTROL", unitPriceCents: 0, amountCents: 0 }), { claimedByMonthId: null }, AT)
  // Green-pool task: never combined.
  m.claim(item({ sourceId: "vg", taskId: "tg", serviceDate: "2026-07-12", itemName: "GREEN POOL", unitPriceCents: 8500, amountCents: 8500 }), { claimedByMonthId: null }, AT)
  m.claim(item({ sourceKind: "usage", sourceId: "ug", taskId: "tg", kind: "consumable", serviceDate: "2026-07-12", itemName: "LIQUID SHOCK 1GAL", qty: 2, unitPriceCents: 1310, amountCents: 2620 }), { claimedByMonthId: null }, AT)
  const terms = [
    { taskId: "t1", labor: "per_visit" as const, consumables: "included" as const },
    { taskId: "tq", labor: "per_visit" as const, consumables: "included" as const, qc: true },
    { taskId: "tg", labor: "per_visit" as const, consumables: "included" as const, green: true },
  ]
  const docs = documentsOf(m, terms, "itemized")
  assert.deepStrictEqual(docs.map((d) => d.kind), ["service", "green"])
  // A month whose ONLY task is green produces NO empty service doc.
  const onlyGreen = BillingMonth.open("m9", 9, "2026-07-01")
  onlyGreen.claim(item({ sourceId: "vg2", taskId: "tg", serviceDate: "2026-07-12", itemName: "GREEN POOL", unitPriceCents: 8500, amountCents: 8500 }), { claimedByMonthId: null }, AT)
  assert.deepStrictEqual(documentsOf(onlyGreen, [{ taskId: "tg", labor: "per_visit", consumables: "included", green: true }], "itemized").map((d) => d.kind), ["green"])
  const svc = docs[0]
  assert.ok(
    svc.lines.some((l) => l.kind === "labor" && l.itemName === "QUALITY CONTROL" && l.amountCents === 0),
    "the QC visit is a $0 line, visible to the customer",
  )
  assert.ok(!svc.lines.some((l) => l.kind !== "visit_break" && l.itemName.includes("GREEN")), "green never combines")
  assert.strictEqual(docs[1].subtotalCents, 8500 + 2620, "the green invoice carries its own labor and chems")
})

check("invoiceNextStep derives collect — no tag, no stale state", () => {
  const base = { preprocessedAt: null, hasActiveInstrument: false, mirrorBalanceCents: 0, latestCharge: "none", emailStatus: null } as const
  assert.strictEqual(invoiceNextStep({ ...base }), "credit_check")
  // Email route: no instrument -> collect never happens.
  assert.strictEqual(invoiceNextStep({ ...base, preprocessedAt: AT, mirrorBalanceCents: 5000 }), "send")
  // Autopay: linked + owed + unattempted -> collect.
  assert.strictEqual(invoiceNextStep({ ...base, preprocessedAt: AT, hasActiveInstrument: true, mirrorBalanceCents: 5000 }), "collect")
  // Nothing owed (a check arrived; the fresh read updated the mirror) -> move along.
  assert.strictEqual(invoiceNextStep({ ...base, preprocessedAt: AT, hasActiveInstrument: true, mirrorBalanceCents: 0 }), "send")
  // An in-flight or half-finished ladder RESUMES at its rung...
  assert.strictEqual(invoiceNextStep({ ...base, preprocessedAt: AT, hasActiveInstrument: true, mirrorBalanceCents: 5000, latestCharge: "requested" }), "collect")
  assert.strictEqual(invoiceNextStep({ ...base, preprocessedAt: AT, hasActiveInstrument: true, mirrorBalanceCents: 5000, latestCharge: "settled" }), "collect")
  // ...a receipted attempt is done -> move along to send.
  assert.strictEqual(invoiceNextStep({ ...base, preprocessedAt: AT, hasActiveInstrument: true, mirrorBalanceCents: 5000, latestCharge: "receipted" }), "send")
  // A DECLINE parks unsent — the earlier ruling stands.
  assert.strictEqual(invoiceNextStep({ ...base, preprocessedAt: AT, hasActiveInstrument: true, mirrorBalanceCents: 5000, latestCharge: "declined" }), null)
  // Sent = done; paid needs no step (the webhook feeds the closed fold).
  assert.strictEqual(invoiceNextStep({ ...base, preprocessedAt: AT, emailStatus: "EmailSent" }), null)
})

console.log(`billing domain selfcheck: ${n} checks passed`)
