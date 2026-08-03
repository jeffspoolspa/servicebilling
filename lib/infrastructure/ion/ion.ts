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
