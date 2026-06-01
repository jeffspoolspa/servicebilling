//bun-extra-requirements:
//node-html-parser@6.1.13
//playwright@1.40.0

// ION reports client (the ION-API "reports" surface).
// (playwright is pinned because this lib imports from f/ION/_lib/session, which uses it.)
//
// Layering (separation of concerns):
//   1. session            -> loginToIon (chromium, cookies)         [f/ION/_lib/session]
//   2. transport/priming  -> ensureReportsPrimed + fetchReportHtml  (generic, raw HTTP)
//   3. per report         -> fetch<Thing>Html (filters -> HTML) + normalize<Thing> (HTML -> typed)
//                            + get<Thing> (compose)
//
// ION report .cfm files read server-side session state the Reports UI sets up; a cold
// call 500s. ensureReportsPrimed replays the UI's request chain ONCE per session; after
// that any report fetch is plain HTTP. Browser is only needed for the initial login.
// Proven 2026-06-01: returns the 487-row recurring-tasks report (byte-identical to manual XLS).

import { ionFetchText, type IonSession } from "/f/ION/_lib/session"
import { parse } from "node-html-parser"

// ---- 2. transport + priming (generic) --------------------------------------

const CF = (cont: string, cid: string, rc: number) =>
  `_cf_containerId=${cont}&_cf_nodebug=true&_cf_nocache=true&_cf_clientid=${cid}&_cf_rc=${rc}`

/**
 * Prime the ColdFusion reports session context for the scheduled-tasks / service-events
 * family. Idempotent (runs once per session). Required before any report in this family
 * returns data. Other report families would register their own prime chain.
 */
export async function ensureReportsPrimed(session: IonSession): Promise<void> {
  if ((session as any)._reportsPrimed) return
  const o = session.ionOrigin
  const cid = session.cfClientId ?? ""
  const today = new Date().toISOString().slice(0, 10)
  await ionFetchText(session, `${o}/reports/reports.cfm?${CF("pageContent", cid, 1)}`)
  await ionFetchText(session, `${o}/reports/CustomerRpt.cfm?${CF("cf_layoutareacenterreports", cid, 2)}`)
  await ionFetchText(session, `${o}/reports/customers.cfm?office=0&zone=0&tech=0&Start=&end=&typeid=0&set=1&${CF("rptDetail", cid, 3)}`)
  await ionFetchText(session, `${o}/reports/serviceEvents.cfm?office=0&tech=0&serviceType=0&Start=${today}&end=&set=1&${CF("rptDetail", cid, 4)}`)
  ;(session as any)._reportsPrimed = true
}

/** Generic report fetcher: primes (once) then returns the report's raw HTML for path + filters. */
export async function fetchReportHtml(
  session: IonSession,
  path: string,
  params: Record<string, string | number> = {},
): Promise<string> {
  await ensureReportsPrimed(session)
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
  return ionFetchText(session, `${session.ionOrigin}${path}${qs ? `?${qs}` : ""}`)
}

/** Generic: extract the data table from an ION HTML-table-as-xls report. */
export function parseReportTable(html: string, headerMarker: string): { headers: string[]; rows: string[][] } {
  const trs = parse(html).querySelectorAll("tr")
  const hi = trs.findIndex((r: any) => r.text.includes(headerMarker))
  if (hi < 0) return { headers: [], rows: [] }
  const cells = (tr: any) => tr.querySelectorAll("td,th").map((c: any) => c.text.replace(/\s+/g, " ").trim())
  const headers = cells(trs[hi])
  const rows = trs.slice(hi + 1).map(cells).filter((r) => r.length >= headers.length && r[0])
  return { headers, rows }
}

// ---- 3. recurring tasks (per-report: fetch + normalize + get) ---------------

export interface RecurringTask {
  ionCustId: string; customerName: string; serviceAddress: string; city: string; state: string; zip: string
  customerType: string; zone: string; facilityDescription: string; lockCombo: string; routeName: string; seq: string
  serviceType: string; ionTaskId: string; taskStart: string; taskEnd: string; taskPrice: string; techPay: string
  serviceRepeat: string; serviceProfile: string; billingType: string; lastVisit: string; recurringNotes: string
}

const RT_COLS: (keyof RecurringTask)[] = [
  "ionCustId","customerName","serviceAddress","city","state","zip","customerType","zone","facilityDescription",
  "lockCombo","routeName","seq","serviceType","ionTaskId","taskStart","taskEnd","taskPrice","techPay",
  "serviceRepeat","serviceProfile","billingType","lastVisit","recurringNotes",
]

/** Fetch the raw "Recurring Tasks Detail - Active Only" report HTML (filters optional). */
export function fetchRecurringTasksHtml(
  session: IonSession,
  filters: Record<string, string | number> = {},
): Promise<string> {
  return fetchReportHtml(session, "/reports/_xls/RecurringtasksActive.cfm", {
    techid: 0, OfficeID: 0, serviceType: 0, ...filters,
  })
}

/** Normalize the recurring-tasks report HTML into typed rows. */
export function normalizeRecurringTasks(html: string): RecurringTask[] {
  const { rows } = parseReportTable(html, "Cust ID")
  return rows.map((c) => {
    const o: any = {}
    RT_COLS.forEach((k, i) => (o[k] = c[i] ?? ""))
    return o as RecurringTask
  })
}

/** High-level: get all active recurring tasks as typed rows. */
export async function getRecurringTasks(
  session: IonSession,
  filters: Record<string, string | number> = {},
): Promise<RecurringTask[]> {
  return normalizeRecurringTasks(await fetchRecurringTasksHtml(session, filters))
}

export function main() {
  return {
    library: "f/ION/_lib/reports",
    transport: ["ensureReportsPrimed", "fetchReportHtml", "parseReportTable"],
    recurringTasks: ["fetchRecurringTasksHtml", "normalizeRecurringTasks", "getRecurringTasks"],
  }
}
