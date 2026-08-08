/**
 * RE-MINT the agreements book at CUSTOMER grain (RULED 2026-08-08).
 *
 * The bootstrap minted one agreement per ION task; the ruling is one active
 * agreement per customer, stops typed (clean | chem_check), ION's task
 * splitting absorbed as incarnation `covers` selectors. This script wipes
 * the day-old reflections (agreements + routing + their bootstrap facts)
 * and rebuilds from the stored intake translations — no ION fetch.
 *
 * Era algorithm (per customer + program):
 *   boundaries = every task's startsOn and endsOn+1day
 *   an era = a window between consecutive boundaries with a non-empty
 *   active-task set; consecutive eras with identical meaning collapse.
 *   Each era -> one TermsVersion { pattern per type, billing per type }.
 *   Carpenter: biweekly@65 era then weekly@50 era = terms v1 + v2.
 *   Bull River: current era + the 2027 renewal = future-dated v2.
 *
 * Incarnations: every task = one row, covers {stopType, ionProfileId},
 * to_at = its endsOn when past, cause = opened | terms_change |
 * placement_change (did the adjacent era change meaning or only stops?).
 *
 * Quotas: one per (agreement, CURRENT terms version), placement v1 = the
 * typed stops of tasks active today.
 *
 *   npx tsx scripts/agreements/remint-customer-grain.ts
 */

import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { programOf, stopTypeOf, type Frequency, type Program, type StopType } from "../../lib/external/ion/task-translation"
import { classifyBasis } from "../../lib/agreements/application/classify-basis"

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const agr = createClient(URL_, KEY, { db: { schema: "agreements" } })
const rt = createClient(URL_, KEY, { db: { schema: "routing" } })
const maint = createClient(URL_, KEY, { db: { schema: "maintenance" } })
const pub = createClient(URL_, KEY)

const TODAY = new Date().toISOString().slice(0, 10)

async function all<T>(q: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw error
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) return out
  }
}

interface Tr {
  ionTaskId: string
  ionCustomerId: string
  program: Program
  stopType: StopType
  ionProfileId: string
  frequency: Frequency
  stops: { weekday: number; techId: string }[]
  startsOn: string | null
  endsOn: string | null
  billing: object
  observedAt: string
}

const plusDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

async function main() {
  /* ------------------------- load + enrich translations ------------------- */
  const rows = await all<{ ion_task_id: string; observed_at: string; translation: unknown }>((f, t) =>
    agr.from("intake_translations").select("ion_task_id, observed_at, translation").range(f, t),
  )
  const latest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) {
    const cur = latest.get(r.ion_task_id)
    if (!cur || r.observed_at > cur.observed_at) latest.set(r.ion_task_id, r)
  }

  // pre-program translations: resolve service-type label via the tasks blob
  const taskBlobs = await all<{ ion_task_id: string; external_data: { service_type?: string } | null }>((f, t) =>
    maint.from("tasks").select("ion_task_id, external_data").not("ion_task_id", "is", null).range(f, t),
  )
  const labelOfSvcId = new Map<string, string>()
  for (const tb of taskBlobs) {
    const r = latest.get(tb.ion_task_id)
    const label = tb.external_data?.service_type
    if (r && label) {
      const svcId = (r.translation as { billing: { inputs: { serviceTypeId: string } } } & object).billing.inputs.serviceTypeId
      labelOfSvcId.set(svcId, label)
    }
  }

  const trs: Tr[] = []
  const skipped: string[] = []
  for (const [ionTaskId, r] of latest) {
    const t = r.translation as unknown as {
      ionCustomerId: string
      program?: Program
      stopType?: StopType
      ionProfileId?: string
      retained: { profileId: string }
      schedule: { frequency: Frequency; stops: { weekday: number; techId: string }[]; period: { startsOn: string | null; endsOn: string | null } }
      billing: { inputs: { serviceTypeId: string } }
    }
    const label = labelOfSvcId.get(t.billing.inputs.serviceTypeId)
    const program = t.program ?? (label ? programOf(label) : null)
    const stopType = t.stopType ?? (label ? stopTypeOf(label) : null)
    if (!program || !stopType) {
      skipped.push(`${ionTaskId}: unresolvable service type (${label ?? "no label"})`)
      continue
    }
    trs.push({
      ionTaskId, ionCustomerId: t.ionCustomerId, program, stopType,
      ionProfileId: t.ionProfileId ?? t.retained.profileId,
      frequency: t.schedule.frequency, stops: t.schedule.stops,
      startsOn: t.schedule.period.startsOn, endsOn: t.schedule.period.endsOn,
      billing: t.billing as object, observedAt: r.observed_at,
    })
  }

  // ION customer -> our customer (qbo id, matching bootstrap's customer_id)
  const custs = await all<{ ion_cust_id: string | null; qbo_customer_id: number | null }>((f, t) =>
    pub.from("Customers").select("ion_cust_id, qbo_customer_id").not("ion_cust_id", "is", null).range(f, t),
  )
  const ourCustOf = new Map(custs.map((c) => [String(c.ion_cust_id), String(c.qbo_customer_id ?? "")]))

  /* ------------------------------ wipe the floor -------------------------- */
  console.log("wiping day-old reflections (agreements + routing + bootstrap facts)…")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wipes: [any, string, string, string | number][] = [
    [rt, "placement_versions", "version", -1],
    [rt, "quotas", "terms_version", -1],
    [agr, "ion_incarnations", "ion_task_id", ""],
    [agr, "terms_versions", "version", -1],
    [agr, "service_agreements", "status", "zzz"],
  ]
  for (const [client, table, col, sentinel] of wipes) {
    const { error } = await client.from(table).delete().neq(col, sentinel)
    if (error) throw new Error(`wipe ${table}: ${(error as { message: string }).message}`)
  }
  // maintenance.events is append-only (trigger-enforced) — correctly. The
  // bootstrap facts stay as history; the re-mint's agreement_opened facts
  // carry source "remint_customer_grain" and reference the LIVE aggregates.

  /* ----------------------------- group + mint ----------------------------- */
  const byCustomerProgram = new Map<string, Tr[]>()
  for (const t of trs) {
    const key = `${t.ionCustomerId}|${t.program}`
    const list = byCustomerProgram.get(key) ?? []
    list.push(t)
    byCustomerProgram.set(key, list)
  }

  const stats = { agreements: 0, multi_task: 0, terms_versions: 0, incarnations: 0, quotas: 0, riders: 0, skipped: skipped.length }
  const now = new Date().toISOString()
  const events: object[] = []
  const mintedMaintByCust = new Map<string, string>() // ourCustomerId -> agreementId

  // maintenance first so riders can find their hosts
  const keys = [...byCustomerProgram.keys()].sort((a, b) =>
    (a.endsWith("|maintenance") ? 0 : 1) - (b.endsWith("|maintenance") ? 0 : 1))

  for (const key of keys) {
    const tasks = byCustomerProgram.get(key)!
    const [ionCust, program] = key.split("|") as [string, Program]
    const ourCust = ourCustOf.get(ionCust) ?? ionCust
    if (tasks.length > 1) stats.multi_task++

    // era boundaries
    const bounds = new Set<string>()
    for (const t of tasks) {
      bounds.add(t.startsOn ?? TODAY)
      if (t.endsOn) bounds.add(plusDay(t.endsOn))
    }
    const sorted = [...bounds].sort()
    const activeIn = (from: string) =>
      tasks.filter((t) => (t.startsOn ?? "0000") <= from && (!t.endsOn || plusDay(t.endsOn) > from))

    type Era = { from: string; tasks: Tr[]; pattern: Record<string, Frequency>; billing: Record<string, object> }
    const eras: Era[] = []
    for (const from of sorted) {
      const act = activeIn(from)
      if (!act.length) continue
      const pattern: Record<string, Frequency> = {}
      const billing: Record<string, object> = {}
      for (const type of ["clean", "chem_check"] as const) {
        const ofType = act.filter((t) => t.stopType === type)
        if (!ofType.length) continue
        const nonWeekly = ofType.find((t) => t.frequency.kind !== "weekly")
        if (ofType.length === 1 && nonWeekly) pattern[type] = nonWeekly.frequency
        else {
          const days = new Set(ofType.flatMap((t) => t.stops.map((s) => s.weekday)))
          pattern[type] = { kind: "weekly", timesPerWeek: Math.min(Math.max(days.size, 1), 7) as 1 }
        }
        billing[type] = ofType[0].billing // representative; inputs re-derivable per task
      }
      const prev = eras[eras.length - 1]
      if (prev && JSON.stringify(prev.pattern) === JSON.stringify(pattern) && JSON.stringify([...act.map((a) => a.ionTaskId)].sort()) === JSON.stringify([...prev.tasks.map((a) => a.ionTaskId)].sort())) continue
      eras.push({ from, tasks: act, pattern, billing })
    }
    if (!eras.length) continue

    // one agreement; era 1 opens it
    const agreementId = randomUUID()
    const basis = program === "maintenance"
      ? { kind: "customer_contract" as const, program }
      : await classifyBasis(program, ourCust, {
          async activeMaintenanceAgreement(c) {
            const id = mintedMaintByCust.get(c)
            return id ? { id } : null
          },
        })
    if (basis.kind === "rider") stats.riders++

    const { error: eA } = await agr.from("service_agreements").insert({
      id: agreementId, customer_id: ourCust, basis: basis as object, status: "active",
    })
    if (eA) throw new Error(`agreement insert (${key}): ${(eA as { message: string }).message}`)
    if (program === "maintenance") mintedMaintByCust.set(ourCust, agreementId)
    stats.agreements++

    // terms versions: era k -> version k. Meaning change vs stop-only change
    // decides the incarnation cause at each boundary.
    let version = 0
    for (const era of eras) {
      const prev = eras[version - 1]
      const meaningChanged = !prev || JSON.stringify(prev.pattern) !== JSON.stringify(era.pattern)
      if (meaningChanged || version === 0) {
        version++
        const { error } = await agr.from("terms_versions").insert({
          agreement_id: agreementId, version,
          pattern: era.pattern as object, billing: era.billing as object,
          period: { startsOn: era.tasks[0].startsOn, endsOn: null },
          from_at: `${era.from}T00:00:00Z`, cause: version === 1 ? "opened" : "ion_side",
        })
        if (error) throw new Error(`terms insert: ${(error as { message: string }).message}`)
        stats.terms_versions++
      }
      ;(era as Era & { version?: number }).version = version
    }

    // incarnations: one per task; cause from what changed at its start
    for (const t of tasks) {
      const eraAtStart = eras.find((e) => e.tasks.includes(t))
      const idx = eraAtStart ? eras.indexOf(eraAtStart) : 0
      const prev = idx > 0 ? eras[idx - 1] : null
      const cause = idx === 0 || !prev ? "opened"
        : JSON.stringify(prev.pattern) !== JSON.stringify(eraAtStart!.pattern) ? "terms_change"
        : "placement_change"
      const endedInPast = t.endsOn !== null && t.endsOn < TODAY
      const { error } = await agr.from("ion_incarnations").insert({
        agreement_id: agreementId, ion_task_id: t.ionTaskId,
        from_at: `${t.startsOn ?? era0(eras)}T00:00:00Z`,
        to_at: endedInPast ? `${t.endsOn}T00:00:00Z` : null,
        cause, covers: { stopType: t.stopType, ionProfileId: t.ionProfileId },
      })
      if (error) throw new Error(`incarnation insert ${t.ionTaskId}: ${(error as { message: string }).message}`)
      stats.incarnations++
    }

    // quota + placement v1 for the CURRENT era (tasks active today)
    const current = eras.filter((e) => e.from <= TODAY).pop()
    if (current) {
      const curVersion = (current as Era & { version?: number }).version ?? 1
      const { data: q, error: eQ } = await rt.from("quotas")
        .insert({ agreement_id: agreementId, terms_version: curVersion }).select("id").single()
      if (eQ) throw new Error(`quota insert: ${(eQ as { message: string }).message}`)
      const stops = current.tasks
        .filter((t) => !t.endsOn || t.endsOn >= TODAY)
        .flatMap((t) => t.stops.map((s) => ({ ...s, type: t.stopType })))
      const { error: eP } = await rt.from("placement_versions").insert({
        quota_id: q!.id, version: 1, stops: stops as object,
        from_date: current.from > TODAY ? current.from : TODAY, cause: "opened",
      })
      if (eP) throw new Error(`placement insert: ${(eP as { message: string }).message}`)
      stats.quotas++
    }

    events.push({
      aggregate: "agreement", aggregate_id: agreementId, type: "agreement_opened",
      actor: "system", occurred_at: now,
      participants: [`agreement:${agreementId}`, `customer:${ourCust}`, ...tasks.map((t) => `ion_task:${t.ionTaskId}`)],
      payload: {
        basis, terms_versions: version, incarnations: tasks.length,
        provenance: "reflection", source: "remint_customer_grain",
      },
    })
  }
  if (events.length) {
    for (let i = 0; i < events.length; i += 500) {
      const { error } = await maint.from("events").insert(events.slice(i, i + 500))
      if (error) throw error
    }
  }

  console.log("=== RE-MINT COMPLETE ===")
  console.log(stats)
  if (skipped.length) {
    console.log("\nskipped (unresolvable service type):")
    for (const s of skipped.slice(0, 10)) console.log(`  ${s}`)
  }
}

const era0 = (eras: { from: string }[]) => eras[0].from

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
