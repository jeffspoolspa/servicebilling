/**
 * ION, as one object (ADR 012). ALL ION communication lives here; no domain
 * logic does. Every hard-won rule from the routing publish week is internal to
 * a method — nothing above this file ever meets a ColdFusion quirk.
 *
 * The base class owns the session: keys are minted by the ONE remaining ION
 * Windmill script (login needs chromium; nothing else does), validity-checked
 * before use, re-minted when dead. Callers never see login exist.
 *
 * IonTasks owns the task actions. Its rules, learned the expensive way:
 *  - a form whose serialized fields are EMPTY did not render — a failed read,
 *    never an empty schedule (acting on one nearly wiped 30 schedules)
 *  - a write is proven by READ-BACK, never by its status code (ION returns
 *    200 and silently drops what it dislikes)
 *  - a write is a COMPLETE form: read the current one, merge our changes over
 *    it, POST the whole thing. That one read is the merge base and pays for
 *    the layer's own assertions; nothing else re-reads it
 *
 * What ION does NOT decide here is WHICH write to send. Publishing refreshes
 * the cache first, so the cache is the authority on cadence and on who sits
 * where; this layer only refuses to send a payload the live form cannot take.
 */

import { parse } from "node-html-parser"

export interface IonSessionKeys {
  ionOrigin: string
  cookieHeader: string
}

export interface SessionMinter {
  mint(forceRefresh: boolean): Promise<IonSessionKeys>
}

/** A parsed task edit form: every field a browser would POST, plus the day picker. */
export interface IonTaskForm {
  fields: Record<string, string>
  /** weekday(0=Sun) -> ION employee id, from the day selects. Empty when no picker. */
  days: Record<string, string>
  serviceRepeat: string
  serviceRepeatText: string
  startsOn: string
  /** fields empty = the form did not render. Nothing about it may be trusted. */
  rendered: boolean
}

export abstract class Ion {
  private keys: IonSessionKeys | null = null

  constructor(protected readonly minter: SessionMinter) {}

  /** Working keys, validity-checked; re-minted when dead. The only session door. */
  protected async session(): Promise<IonSessionKeys> {
    if (this.keys && (await this.alive(this.keys))) return this.keys
    this.keys = await this.minter.mint(this.keys !== null)
    if (!(await this.alive(this.keys))) throw new Error("ION session invalid even after re-mint")
    return this.keys
  }

  /** A session is alive when an authenticated page comes back as itself, not a login redirect. */
  private async alive(k: IonSessionKeys): Promise<boolean> {
    try {
      const res = await fetch(`${k.ionOrigin}/main.cfm`, {
        headers: this.headers(k),
        redirect: "manual",
      })
      return res.status === 200
    } catch {
      return false
    }
  }

  private headers(k: IonSessionKeys, extra: Record<string, string> = {}): Record<string, string> {
    return {
      Cookie: k.cookieHeader,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      Referer: `${k.ionOrigin}/main.cfm`,
      ...extra,
    }
  }

  protected async get(path: string): Promise<string> {
    const k = await this.session()
    const res = await fetch(`${k.ionOrigin}${path}`, { headers: this.headers(k) })
    if (!res.ok) throw new Error(`ION GET ${path} -> ${res.status}`)
    return res.text()
  }

  /** POST returning the response body — for endpoints that answer with HTML. */
  protected async postText(path: string, body: string): Promise<string> {
    const k = await this.session()
    const res = await fetch(`${k.ionOrigin}${path}`, {
      method: "POST",
      headers: this.headers(k, {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Origin: k.ionOrigin,
      }),
      body,
    })
    if (!res.ok) throw new Error(`ION POST ${path} -> ${res.status}`)
    return res.text()
  }

  protected async post(path: string, body: Record<string, string>): Promise<number> {
    const k = await this.session()
    const res = await fetch(`${k.ionOrigin}${path}`, {
      method: "POST",
      headers: this.headers(k, {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Origin: k.ionOrigin,
      }),
      body: new URLSearchParams(body).toString(),
    })
    return res.status
  }

  /**
   * The ColdFusion AJAX envelope. Some form fields (StartsOn) are guarded by
   * server-side pre-sets the UI performs via _proxy.cfm on change; a bare form
   * POST is silently ignored for them. Found by diffing a real browser trace.
   */
  protected cfEnvelope(rc: number): string {
    const cid = Array.from({ length: 32 }, () => "0123456789ABCDEF"[Math.floor(Math.random() * 16)]).join("")
    return `_cf_containerId=csttasks&_cf_nodebug=true&_cf_nocache=true&_cf_clientid=${cid}&_cf_rc=${rc}`
  }

  /** ION context-loads per customer; some reads/writes misbehave unprimed. */
  protected async primeCustomer(ionCustId: string): Promise<void> {
    await this.get(`/customers/customerTabs.cfm?customerid=${ionCustId}`)
  }
}

const DAY_SELECTS = ["day1", "day2", "day3", "day4", "day5", "day6", "day7"]

export interface WeekWrite {
  key: string
  ionTaskId: string
  ionCustId: string
  /** The ACL decided this from our refreshed cache; ION's form must agree. */
  weekly: boolean
  /** Form fields to change (day1..day7 for weekly, AssignedTo for non-weekly). */
  changes: Record<string, string>
  /** weekday -> ION employee id our cache holds, for the free race guard. */
  believedDays: Record<string, string>
}

export interface VerifiedWrite {
  key: string
  accepted: boolean
  detail: string
  /** The task's day picker AFTER the write, read back — the proof. */
  daysAfter?: Record<string, string>
}

export class IonTasks extends Ion {
  /** Read one task's edit form. Throws on a failed render — never trust it. */
  async readTask(ionTaskId: string, ionCustId?: string): Promise<IonTaskForm> {
    if (ionCustId) await this.primeCustomer(ionCustId)
    const form = this.parseForm(await this.get(`/tasks/addTask.cfm?EventID=${ionTaskId}&isIFrame=1`))
    if (!form.rendered) throw new Error(`ION task ${ionTaskId}: form did not render — failed read, not an empty schedule`)
    return form
  }

  /**
   * Apply writes, one session for the batch. ION only accepts a COMPLETE form,
   * so each write reads the current one as its merge base — that single read
   * also pays, for free, for two assertions this layer owns: that the form can
   * accept the payload the ACL built, and that nobody moved the task between
   * our refresh and now. Then POST, then READ BACK. A status code proves nothing.
   */
  async applyWeeks(writes: WeekWrite[], opts: { dryRun: boolean }): Promise<VerifiedWrite[]> {
    const out: VerifiedWrite[] = []
    for (const w of writes) {
      try {
        const form = await this.readTask(w.ionTaskId, w.ionCustId)

        // The ACL chose the write path from our cache; the form must agree.
        const hasPicker = form.serviceRepeat === "2" || form.serviceRepeat === "1"
        if (hasPicker !== w.weekly) {
          out.push({
            key: w.key,
            accepted: false,
            detail: `cache says ${w.weekly ? "weekly" : "non-weekly"} but ION renders ${form.serviceRepeatText || "?"} — refresh is wrong about this task`,
          })
          continue
        }
        if (w.weekly) {
          const drift = Object.entries({ ...w.believedDays, ...form.days })
            .filter(([d]) => (w.believedDays[d] ?? null) !== (form.days[d] ?? null))
            .map(([d]) => `dow${d} ION=${form.days[d] ?? "none"} cache=${w.believedDays[d] ?? "none"}`)
          if (drift.length > 0) {
            out.push({ key: w.key, accepted: false, detail: `moved in ION since our refresh: ${drift.join("; ")}` })
            continue
          }
        }

        if (opts.dryRun) {
          const changed = Object.keys(w.changes).filter((k) => form.fields[k] !== w.changes[k])
          out.push({ key: w.key, accepted: true, detail: `dry run: ${changed.length} field(s) would change`, daysAfter: form.days })
          continue
        }

        const payload = { ...form.fields, ...w.changes }
        if (!payload["LinkUsed"]) payload["LinkUsed"] = "Save"
        if (!payload["Submit"]) payload["Submit"] = "Submit"
        await this.post(`/tasks/addTask.cfm?EventID=${w.ionTaskId}&isIFrame=1`, payload)

        // Read-back proof: every field we set must now be what ION reports.
        // Prime again first — an unprimed form read 500s for some customers,
        // which would report a LANDED write as failed.
        if (w.ionCustId) await this.primeCustomer(w.ionCustId)
        const after = this.parseForm(await this.get(`/tasks/addTask.cfm?EventID=${w.ionTaskId}&isIFrame=1`))
        if (!after.rendered) {
          out.push({ key: w.key, accepted: false, detail: "read-back form did not render — write unproven, treat as failed" })
          continue
        }
        const wrong = Object.keys(w.changes).find((k) => (after.fields[k] ?? "") !== w.changes[k])
        out.push(
          wrong
            ? {
                key: w.key,
                accepted: false,
                daysAfter: after.days,
                detail: `write did not land: ${wrong} wanted "${w.changes[wrong]}", ION holds "${after.fields[wrong] ?? ""}"`,
              }
            : { key: w.key, accepted: true, daysAfter: after.days, detail: "written and read-back verified" },
        )
      } catch (err) {
        out.push({ key: w.key, accepted: false, detail: err instanceof Error ? err.message : String(err) })
      }
    }
    return out
  }

  /** The customer's task ids, from the same list the ingester reads. */
  async listTaskIds(ionCustId: string): Promise<Set<string>> {
    await this.primeCustomer(ionCustId)
    const html = await this.postText(`/tasks/taskList.cfm`, "limit=200")
    const out = new Set<string>()
    for (const m of html.matchAll(/EventID=(\d+)/g)) out.add(m[1])
    return out
  }

  /**
   * Create a recurring task. The blank form (EventID empty, CustomerID set by
   * priming) supplies every default; our fields merge over it; the StartsOn
   * proxy pre-set runs first (the UI always fires it on change). PROOF is the
   * task-list diff: exactly one new EventID must appear, and its form must
   * read back with the cadence, start date and assignment we sent.
   */
  async createTask(
    t: {
      ionCustId: string
      changes: Record<string, string>
      expect: { serviceRepeat: string; startsOn: string }
    },
    opts: { dryRun: boolean },
  ): Promise<VerifiedWrite & { ionTaskId?: string }> {
    const before = await this.listTaskIds(t.ionCustId)
    const form = this.parseForm(await this.get(`/tasks/addTask.cfm?isIFrame=1`))
    if (!form.rendered) return { key: t.ionCustId, accepted: false, detail: "blank create form did not render" }
    if (form.fields["CustomerID"] !== t.ionCustId) {
      return { key: t.ionCustId, accepted: false, detail: `create form is primed for customer ${form.fields["CustomerID"] ?? "?"}, not ${t.ionCustId} — refusing to create on the wrong account` }
    }
    if ((form.fields["EventID"] ?? "") !== "") {
      return { key: t.ionCustId, accepted: false, detail: "create form carries an EventID — this would EDIT, not create" }
    }

    if (opts.dryRun) {
      return { key: t.ionCustId, accepted: true, detail: `dry run: would create (${Object.keys(t.changes).length} fields over defaults)` }
    }

    await this.get(`/includes/_proxy.cfm?source=addtask&date=${encodeURIComponent(t.expect.startsOn)}&set=1&${this.cfEnvelope(1)}`)
    const payload = { ...form.fields, ...t.changes }
    if (!payload["LinkUsed"]) payload["LinkUsed"] = "Save"
    if (!payload["Submit"]) payload["Submit"] = "Submit"
    await this.post(`/tasks/addTask.cfm?isIFrame=1`, payload)

    const after = await this.listTaskIds(t.ionCustId)
    const fresh = [...after].filter((id) => !before.has(id))
    if (fresh.length !== 1) {
      return { key: t.ionCustId, accepted: false, detail: `expected exactly 1 new task, task list shows ${fresh.length} (${fresh.join(",")})` }
    }
    const ionTaskId = fresh[0]
    const echo = await this.readTask(ionTaskId)
    const wrong =
      echo.serviceRepeat !== t.expect.serviceRepeat
        ? `ServiceRepeat ${echo.serviceRepeat} != ${t.expect.serviceRepeat}`
        : echo.startsOn !== t.expect.startsOn
          ? `StartsOn ${echo.startsOn} != ${t.expect.startsOn}`
          : Object.keys(t.changes).find((k) => k.startsWith("day") && (echo.fields[k] ?? "") !== t.changes[k])
    return wrong
      ? { key: t.ionCustId, accepted: false, ionTaskId, detail: `created ${ionTaskId} but read-back disagrees: ${wrong}` }
      : { key: t.ionCustId, accepted: true, ionTaskId, daysAfter: echo.days, detail: `created ${ionTaskId}, read-back verified` }
  }

  /**
   * Change a start date — the anchor encoding day + alternating-week parity for
   * non-weekly cadences. Requires the _proxy pre-set with the CF envelope;
   * a bare POST silently keeps the old value for backdates. Read-back proven.
   */
  async setStartDate(ionTaskId: string, ionCustId: string, date: string, opts: { dryRun: boolean }): Promise<VerifiedWrite> {
    const form = await this.readTask(ionTaskId, ionCustId)
    if (form.startsOn === date) return { key: ionTaskId, accepted: true, detail: "already correct" }
    if (opts.dryRun) return { key: ionTaskId, accepted: true, detail: `dry run: StartsOn ${form.startsOn} -> ${date}` }
    await this.get(`/includes/_proxy.cfm?source=addtask&date=${encodeURIComponent(date)}&set=1&${this.cfEnvelope(1)}`)
    const payload = { ...form.fields, StartsOn: date, LinkUsed: form.fields["LinkUsed"] || "Save", Submit: form.fields["Submit"] || "Submit" }
    await this.post(`/tasks/addTask.cfm?EventID=${ionTaskId}&isIFrame=1`, payload)
    const after = await this.readTask(ionTaskId)
    return after.startsOn === date
      ? { key: ionTaskId, accepted: true, detail: `StartsOn ${form.startsOn} -> ${date} (read-back verified)` }
      : { key: ionTaskId, accepted: false, detail: `StartsOn write did not land: wanted ${date}, ION holds ${after.startsOn}` }
  }

  /** Serialize the form the way a browser would; the parser is private forever. */
  private parseForm(html: string): IonTaskForm {
    const root = parse(html)
    const forms = root.querySelectorAll("form")
    const form = forms.find((f) => (f.getAttribute("action") || "").includes("addTask")) ?? forms[0]
    const fields: Record<string, string> = {}
    const days: Record<string, string> = {}
    let serviceRepeat = ""
    let serviceRepeatText = ""
    if (form) {
      for (const inp of form.querySelectorAll("input")) {
        const name = inp.getAttribute("name")
        if (!name) continue
        const type = (inp.getAttribute("type") || "text").toLowerCase()
        if (type === "radio" || type === "checkbox") {
          if (inp.getAttribute("checked") != null) fields[name] = inp.getAttribute("value") ?? "on"
        } else fields[name] = inp.getAttribute("value") ?? ""
      }
      for (const sel of form.querySelectorAll("select")) {
        const name = sel.getAttribute("name")
        if (!name) continue
        const opt = sel.querySelector("option[selected]")
        fields[name] = opt ? (opt.getAttribute("value") ?? "") : ""
        const dayIdx = DAY_SELECTS.indexOf(name)
        if (dayIdx >= 0 && fields[name]) days[String(dayIdx)] = fields[name]
        if (name === "ServiceRepeat") {
          serviceRepeat = fields[name]
          serviceRepeatText = (opt?.text ?? "").replace(/\s+/g, " ").trim()
        }
      }
      for (const ta of form.querySelectorAll("textarea")) {
        const name = ta.getAttribute("name")
        if (name) fields[name] = ta.text ?? ""
      }
    }
    return {
      fields,
      days,
      serviceRepeat,
      serviceRepeatText,
      startsOn: fields["StartsOn"] ?? "",
      rendered: Object.keys(fields).length > 0,
    }
  }
}

/* -------------------------------- customers ------------------------------- */

export interface IonCustomerHit {
  ionCustId: string
  /** The list row's text — name, address, phone as ION renders them. */
  rowText: string
}

export class IonCustomers extends Ion {
  /**
   * Search ION's customer list. ION's search box matches a single term best,
   * so callers pass a surname and judge the candidate rows themselves —
   * judging is translation (the ACL), not transport.
   */
  async search(term: string): Promise<IonCustomerHit[]> {
    const html = await this.get(
      `/customers/customerlist.cfm?officeid=0&techid=0&routeid=0&search=${encodeURIComponent(term)}&reset=1`,
    )
    const root = parse(html)
    const out: IonCustomerHit[] = []
    const seen = new Set<string>()
    for (const a of root.querySelectorAll('a[href*="customerTabs"]')) {
      const m = (a.getAttribute("href") || "").match(/customerid=(\d+)/)
      if (!m || seen.has(m[1])) continue
      seen.add(m[1])
      interface NodeLike { tagName?: string; parentNode?: NodeLike | null; text?: string }
      let row: NodeLike | null = a as unknown as NodeLike
      for (let k = 0; k < 5 && row && row.tagName !== "TR"; k++) row = row.parentNode ?? null
      out.push({ ionCustId: m[1], rowText: ((row?.text ?? a.text) || "").replace(/\s+/g, " ").trim() })
    }
    return out
  }
}

/* --------------------------------- reports -------------------------------- */

/** A job runner for the few ION actions that genuinely need a browser. */
export interface IonJobRunner {
  run<T>(path: string, args: Record<string, unknown>): Promise<T>
}

export interface TaskTransactionsPull {
  month: string
  rows: number
  totalCents: number
  pulledAt: string
}

/**
 * ION's reports. Kept on the Ion object like every other ION action, so no
 * caller anywhere assembles a second gateway (ADR 012).
 *
 * This one DELEGATES to a Windmill script rather than using our session, and
 * the reason is the same one that makes login a script: ION's report criteria
 * live in the ColdFusion SESSION and are only set by a real browser
 * navigation form-submit. A fetch POST — even with Chrome's exact headers —
 * gets the form re-rendered with default dates and the criteria silently
 * ignored (verified 2026-07-01; Incapsula sits in front). So chromium is a
 * requirement of the report, not a convenience, and the delegation is the
 * honest way to express that while keeping the method here.
 */
export class IonReports extends Ion {
  constructor(minter: SessionMinter, private readonly jobs: IonJobRunner) {
    super(minter)
  }

  /**
   * Pull the All Transactions report for a month and load it into
   * `billing_audit.ion_task_transactions`. This is the INDEPENDENT side of
   * billing's reconcile — what ION says it billed, per task.
   */
  async pullTaskTransactions(month: string): Promise<TaskTransactionsPull> {
    const ym = month.slice(0, 7)
    const res = await this.jobs.run<{ rows?: number; loaded?: number; total_cents?: number }>(
      "f/ION/transactions_report",
      { month: ym, dry_run: false, load: true },
    )
    return {
      month: ym,
      rows: res.loaded ?? res.rows ?? 0,
      totalCents: res.total_cents ?? 0,
      pulledAt: new Date().toISOString(),
    }
  }
}

/* --------------------------------- visits --------------------------------- */

export interface DayLogPull {
  from: string
  to: string
  visitsTouched: number
}

/**
 * ION's service logs — the source of every visit and every consumable.
 *
 * Like the reports, this delegates to the ingest script rather than using our
 * HTTP session, because refreshing the ION session logs in with a browser.
 * The method lives here so no caller assembles a second ION gateway.
 */
export class IonVisits extends Ion {
  constructor(minter: SessionMinter, private readonly jobs: IonJobRunner) {
    super(minter)
  }

  /**
   * Re-read the logs for an INCLUSIVE ISO date range and upsert them, keyed
   * on LogID.
   *
   * Callers speak ISO; the ingest wants MM/DD/YYYY and parses it by splitting
   * on "/", so an ISO date silently becomes an invalid one, yields zero days
   * and reports success having done nothing. Translating here is the whole
   * point of the object — nothing above it should ever meet ION's date
   * format, and a quiet zero is worse than an error.
   */
  async refreshDays(from: string, to: string): Promise<DayLogPull> {
    const usDate = (iso: string) => {
      const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
      if (!m) throw new Error(`refreshDays wants an ISO date, got "${iso}"`)
      return `${m[2]}/${m[3]}/${m[1]}`
    }
    const res = await this.jobs.run<Record<string, unknown>>(
      "f/ION/ingest_day_logs",
      { start_date: usDate(from), end_date: usDate(to), dry_run: false },
    )
    const days = Number((res.window as { days?: number } | undefined)?.days ?? 0)
    if (days === 0) throw new Error(`ION ingest covered 0 days for ${from}..${to} — the pull did nothing`)
    // The ingest reports per-day; take whichever total it offers rather than
    // guessing one key and reporting a confident zero.
    const n = Number(res.logs_built ?? res.upserted ?? res.visits ?? NaN)
    return { from, to, visitsTouched: Number.isFinite(n) ? n : -1 }
  }
}
