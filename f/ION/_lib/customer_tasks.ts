//bun-extra-requirements:
//node-html-parser@6.1.13
//playwright@1.40.0

// ION per-customer task list (the RICH schedule source).
// (playwright pinned because this imports f/ION/_lib/session, which uses it for login.)
//
// The active-recurring-tasks report (RecurringtasksActive) has no day-of-week or
// tech. The /tasks/taskList.cfm endpoint -- the task table on a customer's page --
// has BOTH, plus the ion task id and expiry, for every cadence:
//   Task ID, Task Created, Task Starts, Task Expires, Assigned To (tech),
//   Description, Recurrence, Next Service.
//
// It is session-primed by the CUSTOMER you've navigated to: a cold POST 500s.
// So we replay the UI: GET /customers/customerTabs.cfm?customerid=<id> to set the
// session customer, THEN POST /tasks/taskList.cfm. (Both raw HTTP with the login
// cookies; chromium only for the initial login.) The customer list with these ids
// is /customers/customerlist.cfm (rows link to customerTabs.cfm?customerid=NNN).
//
// DAYS (per cadence):
//   Weekly    -> recurrence cell marks active weekdays in <b style=...#000000>;
//                letter sequence is S M T W T F S = DOW 0..6 (handles multi-day).
//   Bi-Weekly / Monthly -> recurrence shows only the word; the service day is the
//                weekday of Next Service (== weekday of Task Starts, the anchor).
//                A/B parity = the iso-week parity of Next Service.
//   Daily     -> every day (0..6).
// Proven 2026-06-01 against stored data: task 3369746 -> Mon,Fri; GROOM bi-weekly
// -> Wed; BURNEM bi-weekly -> Tue; all matched maintenance.task_schedules.day_of_week.

import { ionFetch, ionFetchText, type IonSession } from "/f/ION/_lib/session"
import { parse } from "node-html-parser"

export interface CustomerTask {
  ionTaskId: string
  assignedTo: string          // raw ION tech string, e.g. "MNT-B JH, JAYDEN" / "-A ASSIGN PEND"
  description: string         // service type + detail
  recurrence: string          // raw word: Weekly | Bi-Weekly | Daily | Monthly | ...
  activeDays: number[]        // DOW 0=Sun..6=Sat
  nextService: string         // raw, a date or "Expired"
  nextServiceWeekday: number | null
  weekParity: number | null   // iso-week % 2 of Next Service (for Bi-Weekly A/B)
  taskStarts: string
  taskExpires: string         // a date or "Perpetual"
  taskCreated: string
  expired: boolean
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
const DAY_TOKENS = 7 // S M T W T F S

/** Prime the session's customer context (required before taskList returns data). */
export async function primeCustomerContext(session: IonSession, ionCustId: string | number): Promise<void> {
  await ionFetchText(session, `${session.ionOrigin}/customers/customerTabs.cfm?customerid=${ionCustId}`)
}

/** Fetch the raw taskList.cfm HTML for the currently-primed customer. */
export async function fetchCustomerTasksHtml(session: IonSession, ionCustId: string | number, limit = 100): Promise<string> {
  await primeCustomerContext(session, ionCustId)
  const res = await ionFetch(session, `${session.ionOrigin}/tasks/taskList.cfm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "text/html, */*; q=0.01",
      "Referer": `${session.ionOrigin}/main.cfm`,
      "Origin": session.ionOrigin,
      "User-Agent": UA,
    },
    body: `limit=${limit}`,
  })
  if (!res.ok) throw new Error(`taskList ${ionCustId} -> HTTP ${res.status}`)
  return res.text()
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim()

function weekdayOf(dateStr: string): number | null {
  const t = (dateStr || "").trim()
  if (!t || /expired|perpetual/i.test(t)) return null
  const d = new Date(t)
  return isNaN(+d) ? null : d.getUTCDay()
}

function isoWeekParity(dateStr: string): number | null {
  const t = (dateStr || "").trim()
  if (!t || /expired|perpetual/i.test(t)) return null
  const d = new Date(t)
  if (isNaN(+d)) return null
  // days since a fixed Monday epoch (1970-01-05) / 7, mod 2
  const epoch = Date.UTC(1970, 0, 5)
  const weeks = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - epoch) / (7 * 86400000))
  return ((weeks % 2) + 2) % 2
}

/** Weekly recurrence cell innerHTML -> active DOW set (bolded letters, by position). */
function weeklyActiveDays(recurrenceInnerHtml: string): number[] {
  // mark bolded single day-letters, strip remaining tags
  const marked = recurrenceInnerHtml
    .replace(/<b[^>]*>\s*([A-Za-z])\s*<\/b>/gi, "@$1@")
    .replace(/<[^>]+>/g, "")
  const dash = marked.indexOf("-")
  const dayPart = dash >= 0 ? marked.slice(dash + 1) : marked
  const toks = norm(dayPart).split(" ").filter(Boolean)
  const days: number[] = []
  for (let i = 0; i < toks.length && i < DAY_TOKENS; i++) if (toks[i].includes("@")) days.push(i)
  return days
}

/** Parse the taskList.cfm HTML into typed per-task rows. */
export function normalizeCustomerTasks(html: string): CustomerTask[] {
  const root = parse(html)
  let table: any = null
  for (const t of root.querySelectorAll("table")) {
    if (t.text.includes("Task ID") && t.text.includes("Recurrence")) { table = t; break }
  }
  if (!table) return []
  const trs = table.querySelectorAll("tr")

  // locate header row + column indices (robust to column order)
  const wanted: Record<string, RegExp> = {
    id: /task id/i, created: /task created/i, starts: /task starts/i, expires: /task expires/i,
    assigned: /assigned to/i, description: /description/i, recurrence: /recurrence/i, next: /next service/i,
  }
  let headerIdx = -1
  const col: Record<string, number> = {}
  for (let i = 0; i < trs.length; i++) {
    const cells = trs[i].querySelectorAll("td,th").map((c: any) => norm(c.text))
    if (cells.some((c: string) => /task id/i.test(c))) {
      headerIdx = i
      cells.forEach((c: string, idx: number) => {
        for (const [k, re] of Object.entries(wanted)) if (re.test(c) && col[k] === undefined) col[k] = idx
      })
      break
    }
  }
  if (headerIdx < 0 || col.id === undefined) return []

  const out: CustomerTask[] = []
  for (let i = headerIdx + 1; i < trs.length; i++) {
    const tds = trs[i].querySelectorAll("td")
    if (!tds.length) continue
    const ionTaskId = norm(tds[col.id]?.text ?? "")
    if (!/^\d+$/.test(ionTaskId)) continue

    const recCell = tds[col.recurrence]
    const recHtml = recCell ? recCell.innerHTML : ""
    const recurrence = norm((recCell?.text ?? "")).split(/[\s-]/)[0] +
      (/bi-?weekly/i.test(recCell?.text ?? "") ? "" : "") // keep simple; full word below
    const recWordMatch = norm(recCell?.text ?? "").match(/^(Bi-?Weekly|Weekly|Daily|Monthly|Quarterly|Yearly|One ?Time|[A-Za-z]+)/i)
    const recWord = recWordMatch ? recWordMatch[1] : recurrence

    const nextService = norm(tds[col.next]?.text ?? "")
    const taskStarts = norm(tds[col.starts]?.text ?? "")
    const taskExpires = norm(tds[col.expires]?.text ?? "")
    const taskCreated = norm(tds[col.created]?.text ?? "")
    const assignedTo = norm(tds[col.assigned]?.text ?? "")
    const description = norm(tds[col.description]?.text ?? "")

    const nextWd = weekdayOf(nextService)
    let activeDays: number[]
    if (/^weekly$/i.test(recWord)) {
      activeDays = weeklyActiveDays(recHtml)
      if (activeDays.length === 0 && nextWd !== null) activeDays = [nextWd] // fallback
    } else if (/daily/i.test(recWord)) {
      activeDays = [0, 1, 2, 3, 4, 5, 6]
    } else {
      // Bi-Weekly / Monthly / etc: single service day = weekday of Next Service (anchor)
      const wd = nextWd ?? weekdayOf(taskStarts)
      activeDays = wd !== null ? [wd] : []
    }

    out.push({
      ionTaskId, assignedTo, description, recurrence: recWord,
      activeDays, nextService, nextServiceWeekday: nextWd,
      weekParity: isoWeekParity(nextService) ?? isoWeekParity(taskStarts),
      taskStarts, taskExpires, taskCreated,
      expired: /expired/i.test(nextService) || (weekdayOf(taskExpires) !== null && new Date(taskExpires) < new Date()),
    })
  }
  return out
}

/** High-level: all tasks for one customer, typed. */
export async function getCustomerTasks(session: IonSession, ionCustId: string | number): Promise<CustomerTask[]> {
  return normalizeCustomerTasks(await fetchCustomerTasksHtml(session, ionCustId))
}

export function main() {
  return {
    library: "f/ION/_lib/customer_tasks",
    exports: ["primeCustomerContext", "fetchCustomerTasksHtml", "normalizeCustomerTasks", "getCustomerTasks"],
  }
}
