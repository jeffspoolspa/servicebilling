/**
 * TaskService — the one entry point for adding and changing tasks.
 *
 * This is Evans' "client" in figure 6.23: it asks the FACTORY for an object,
 * then hands it to the REPOSITORY. It is kept thin on purpose — it contains no
 * business rule or knowledge, only the sequence. Every `if` about what a legal
 * task is lives in the Task aggregate; if one ever appears here, it has escaped
 * and should be moved down.
 *
 * It holds no business state. It does return progress state (what landed, what
 * refused), which Evans explicitly permits: "state that reflects the progress
 * of a task for the user or the program".
 *
 * Any caller drives it — an API route, a script, a form on the customer page,
 * or an agent working from a list. That is the whole point of putting the use
 * case here instead of in a route handler: there is one path, so there is only
 * one thing to get right.
 */

import { Task, type Terms, type TaskGateway, type TaskRepository, type FreshnessSource, type TaskRoster } from "@/lib/maintenance/domain"

export interface TaskOutcome {
  readonly ok: boolean
  /** Our task id, once it exists. */
  readonly taskId: string | null
  readonly ionTaskId: string | null
  readonly detail: string
  /** The exact ION payload, so a dry run is inspectable before it is real. */
  readonly payload?: Record<string, string>
}

export class TaskService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly ion: TaskGateway,
    /**
     * Optional, but a supersede REFUSES without it: the successor's anchor is
     * derived from the current contract, so computing it from a stale row
     * produces a confidently wrong date.
     */
    private readonly freshness?: FreshnessSource,
    /** Needed only to notice DELETED tasks; refresh works without it. */
    private readonly roster?: TaskRoster,
    /**
     * Where an outside edit gets recorded. The APPLICATION records, not the
     * adapter that noticed: the same slot going quiet means "ION dropped the
     * day" on a refresh and "we superseded the contract" on an edit, and only
     * this layer knows which. Optional so a probe can refresh silently.
     */
    private readonly events?: {
      append(facts: readonly {
        aggregate: "task" | "schedule"; aggregateId: string; type: string
        actor?: string; participants?: string[]; payload?: Record<string, unknown>
      }[]): Promise<{ written: number; failed: string[] }>
    },
  ) {}

  /**
   * Make our copy of these tasks true — one, a list, or the whole active book.
   *
   * The one entry point for freshness, because every caller needs the same
   * thing and they were each about to grow their own: the nightly sweep, the
   * map's refresh button, and editTask's own precondition before it computes
   * an anchor from what we hold.
   *
   * DELETION is the case only this can see. A task we hold that ION no longer
   * lists for its customer is gone — visits cannot tell us, because a deleted
   * task simply stops producing them, which looks exactly like a pool closed
   * for the winter until months have passed. The roster is read per CUSTOMER,
   * so it costs one call however many tasks they have.
   *
   * A roster read that FAILS is never treated as deletion. Closing a live
   * contract because ION was briefly unreachable is worse than staying stale.
   */
  async refreshTasks(
    taskIds: readonly string[],
    opts: { at?: string; detectDeleted?: boolean } = {},
  ): Promise<{
    verified: string[]
    deleted: { taskId: string; ionTaskId: string }[]
    skipped: { taskId: string; reason: string }[]
  }> {
    if (taskIds.length === 0) return { verified: [], deleted: [], skipped: [] }
    if (!this.freshness) {
      return { verified: [], deleted: [], skipped: taskIds.map((taskId) => ({ taskId, reason: "no freshness source configured" })) }
    }

    const r = await this.freshness.refresh(taskIds)

    // Every disagreement is an edit made outside our system — this log is the
    // only record it will ever have, so it carries the old value AND the new.
    if (this.events && r.drift && r.drift.length > 0) {
      await this.events.append(
        r.drift.map((d) => ({
          aggregate: "task" as const,
          aggregateId: d.taskId,
          type: "TaskUpdated",
          actor: "task_refresh",
          payload: { before: d.before, after: d.after, source: "ion" },
        })),
      )
    }

    const deleted: { taskId: string; ionTaskId: string }[] = []
    if (!(opts.detectDeleted ?? true) || !this.roster) return { ...r, deleted }

    // Group by customer: one roster read covers all of that customer's tasks.
    const loaded = (await Promise.all(taskIds.map((id) => this.tasks.byId(id)))).filter((t): t is Task => t !== null)
    const byCustomer = new Map<number, Task[]>()
    for (const t of loaded) {
      if (!t.ionTaskId || t.status === "closed") continue
      const held = byCustomer.get(t.customerId)
      if (held) held.push(t)
      else byCustomer.set(t.customerId, [t])
    }

    for (const [customerId, tasks] of byCustomer) {
      let live: Set<string>
      try {
        live = await this.roster.idsFor(customerId)
      } catch (err) {
        for (const t of tasks) r.skipped.push({ taskId: t.id!, reason: `roster read failed: ${err instanceof Error ? err.message : String(err)}` })
        continue
      }
      // An EMPTY roster is a failed read wearing a success. A customer we hold
      // tasks for has tasks; believing otherwise would close every one.
      if (live.size === 0) {
        for (const t of tasks) r.skipped.push({ taskId: t.id!, reason: "ION returned an empty task list — treated as a failed read, not as deletion" })
        continue
      }
      for (const t of tasks) {
        if (live.has(t.ionTaskId!)) continue
        const wasServiced = {
          days: Object.fromEntries(t.terms.slots.map((sl) => [String(sl.weekday), sl.techId])),
          frequency: t.terms.slots[0]?.frequency ?? null,
          startsOn: t.terms.startsOn,
          endsOn: t.terms.endsOn,
        }
        const endsOn = (opts.at ?? new Date().toISOString()).slice(0, 10)
        t.close(opts.at, endsOn)
        await this.tasks.save(t)
        deleted.push({ taskId: t.id!, ionTaskId: t.ionTaskId! })
        // A task gone from ION is the SAME event as any other change — the
        // end date is what says it is over. One fact type, no taxonomy.
        await this.events?.append([{
          aggregate: "task", aggregateId: t.id!, type: "TaskUpdated", actor: "task_refresh",
          participants: [`customer:${t.customerId}`],
          payload: {
            before: wasServiced,
            after: { ...wasServiced, days: {}, endsOn },
            source: "ion",
            note: "ION no longer lists this task for the customer",
          },
        }])
      }
    }
    return { ...r, deleted }
  }

  /**
   * Add a task. No id argument, because the thing being created has no
   * identity yet — the asymmetry with editTask is the model's, not a style
   * choice.
   *
   * Order matters and is the reason this method exists: ION mints the identity,
   * so it is written FIRST, and only a created task gets recorded. Recording
   * before writing would invent a task that does not exist; not recording after
   * writing would orphan one that does (see f/ION/recover_orphan_tasks for what
   * that costs).
   */
  async addTask(
    customerId: number,
    terms: Terms,
    opts: { dryRun?: boolean; at?: string } = {},
  ): Promise<TaskOutcome> {
    const dryRun = opts.dryRun ?? true

    // The one-open-task-per-location rule is the database's, so the answer
    // comes from the repository — the aggregate cannot see its siblings.
    const existing = await this.tasks.openTaskFor(customerId)
    if (existing) {
      return {
        ok: false,
        taskId: existing.id,
        ionTaskId: existing.ionTaskId,
        detail:
          "this customer already has an open task — a service that charges differently is a second task, decide deliberately",
      }
    }

    // The FACTORY decides whether this is a legitimate contract. It throws
    // rather than returning invalid, so there is no half-valid Task to handle.
    let task: Task
    try {
      task = Task.open(customerId, terms, opts.at)
    } catch (err) {
      return { ok: false, taskId: null, ionTaskId: null, detail: err instanceof Error ? err.message : String(err) }
    }

    const res = await this.ion.create(task.desiredWeek(), { dryRun })
    if (!res.accepted) {
      return { ok: false, taskId: null, ionTaskId: null, detail: res.detail, payload: res.payload }
    }
    if (dryRun) {
      return { ok: true, taskId: null, ionTaskId: null, detail: res.detail, payload: res.payload }
    }

    // Live and accepted: record it, including the facts the aggregate kept.
    task.identify(crypto.randomUUID(), res.ionTaskId!)
    await this.tasks.save(task)
    // The counterpart to TaskUpdated: a task begins. Same state shape, no
    // `before`, so a history reads as one series without special-casing.
    await this.events?.append([{
      aggregate: "task", aggregateId: task.id!, type: "TaskAdded", actor: "task_service",
      participants: [`customer:${task.customerId}`],
      payload: { after: {
        days: Object.fromEntries(task.terms.slots.map((sl) => [String(sl.weekday), sl.techId])),
        frequency: task.terms.slots[0]?.frequency ?? null,
        startsOn: task.terms.startsOn,
        endsOn: task.terms.endsOn,
      }, ionTaskId: task.ionTaskId },
    }])
    return { ok: true, taskId: task.id, ionTaskId: task.ionTaskId, detail: res.detail }
  }

  /**
   * Change an existing task. Takes an id because the task already exists.
   *
   * The service never mutates the task itself — it loads it, tells it to
   * change, and hands it back. The transition and its invariants belong to the
   * aggregate.
   */
  async editTask(
    taskId: string,
    terms: Terms,
    opts: { dryRun?: boolean; at?: string } = {},
  ): Promise<TaskOutcome> {
    const dryRun = opts.dryRun ?? true
    const task = await this.tasks.byId(taskId)
    if (!task) return { ok: false, taskId, ionTaskId: null, detail: `no task ${taskId}` }
    if (!task.ionTaskId) {
      return { ok: false, taskId, ionTaskId: null, detail: "this task does not exist in ION — add it first" }
    }

    // WHAT MOVED decides the shape (I-T8), never the caller. A day, cadence,
    // price or service-type change cannot be edited in place: ION generates
    // visits FROM StartsOn, so rewriting the anchor re-derives visits already
    // serviced and invoiced. Those supersede — the old contract ends and a new
    // one begins.
    const kind = task.revisionKind(terms)
    if (kind === "supersede") {
      // The successor's anchor comes from the CURRENT contract, so it must be
      // true first. Bayens (2026-08-05): our row held starts_on 2025-01-03 and
      // no live cadence while ION held 2024-12-30 Bi-Weekly — computing from
      // the cache would have anchored the new task in the wrong week.
      if (!this.freshness) {
        return { ok: false, taskId, ionTaskId: task.ionTaskId,
          detail: "refusing to supersede without a freshness source — the anchor would be computed from a possibly stale contract" }
      }
      const r = await this.freshness.refresh([taskId])
      if (!r.verified.includes(taskId)) {
        const why = r.skipped.find((x) => x.taskId === taskId)?.reason ?? "not verified"
        return { ok: false, taskId, ionTaskId: task.ionTaskId, detail: `could not verify this task against ION before superseding: ${why}` }
      }
      const fresh = await this.tasks.byId(taskId)
      if (!fresh) return { ok: false, taskId, ionTaskId: task.ionTaskId, detail: "task vanished during refresh" }
      // byId returned it, so it is persisted and carries an id.
      return this.supersedeTask(fresh as Task & { id: string }, terms, { dryRun, at: opts.at })
    }

    const beforeEdit = {
        days: Object.fromEntries(task.terms.slots.map((sl) => [String(sl.weekday), sl.techId])),
        frequency: task.terms.slots[0]?.frequency ?? null,
        startsOn: task.terms.startsOn,
        endsOn: task.terms.endsOn,
      }
    try {
      task.changeTerms(terms, opts.at)
    } catch (err) {
      return { ok: false, taskId, ionTaskId: task.ionTaskId, detail: err instanceof Error ? err.message : String(err) }
    }

    const res = await this.ion.update(task.ionTaskId, task.desiredWeek(), { dryRun })
    if (!res.accepted || dryRun) {
      return {
        ok: res.accepted,
        taskId,
        ionTaskId: task.ionTaskId,
        detail: res.detail,
        payload: res.payload,
      }
    }
    const after = {
        days: Object.fromEntries(task.terms.slots.map((sl) => [String(sl.weekday), sl.techId])),
        frequency: task.terms.slots[0]?.frequency ?? null,
        startsOn: task.terms.startsOn,
        endsOn: task.terms.endsOn,
      }
    await this.tasks.save(task)
    await this.events?.append([{
      aggregate: "task", aggregateId: taskId, type: "TaskUpdated", actor: "task_service",
      participants: [`customer:${task.customerId}`],
      payload: { before: beforeEdit, after, source: "app" },
    }])
    return { ok: true, taskId, ionTaskId: task.ionTaskId, detail: res.detail }
  }

  /**
   * End the contract and begin its successor.
   *
   * Not an edit: ION's StartsOn IS the schedule for a non-picker cadence, so
   * the only honest way to move a day is a new agreement. The old task is
   * closed the day before the new one starts — no overlap, no gap.
   *
   * ORDER is forced by tasks_one_open_per_loc: close, then create. And the
   * create is checked FIRST for an existing successor, because a retry that
   * creates twice leaves the customer with two live contracts — worse than the
   * failure it was retrying.
   */
  private async supersedeTask(
    task: Task & { id: string },
    next: Terms,
    opts: { dryRun: boolean; at?: string },
  ): Promise<TaskOutcome> {
    const ionTaskId = task.ionTaskId!
    const startsOn = next.startsOn
    const endsOn = new Date(Date.parse(`${startsOn}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
    if (endsOn < task.terms.startsOn) {
      return { ok: false, taskId: task.id, ionTaskId,
        detail: `a successor starting ${startsOn} would end the current contract (${task.terms.startsOn}) before it began` }
    }

    // 0. ask what already landed. Both steps below are irreversible, and a
    //    second create would leave the customer holding two live contracts —
    //    strictly worse than the failure being retried. This mirrors the
    //    publish path, which learned it the hard way on 2026-08-05.
    let alreadyClosed = false
    if (!opts.dryRun) {
      if (!this.ion.inspect) {
        return { ok: false, taskId: task.id, ionTaskId,
          detail: "supersede refused: this gateway cannot report what ION already holds, and a blind retry can create a second live contract" }
      }
      const seen = await this.ion.inspect(ionTaskId)
      const successorAlready = seen.siblings.find(
        (s) => s.ionTaskId !== ionTaskId && s.startsOn === startsOn,
      )
      if (successorAlready) {
        return { ok: true, taskId: task.id, ionTaskId,
          detail: `already superseded on a previous attempt — successor is ION task ${successorAlready.ionTaskId}, starting ${startsOn}` }
      }
      alreadyClosed = seen.endsOn === endsOn
    }

    // 1. close the old contract in ION
    if (!alreadyClosed) {
      const closed = await this.ion.update(
        ionTaskId, { ...task.desiredWeek(), endsOn }, { dryRun: opts.dryRun },
      )
      if (!closed.accepted) {
        return { ok: false, taskId: task.id, ionTaskId, detail: `close refused: ${closed.detail}`, payload: closed.payload }
      }
    }

    // 2. begin the successor
    const successor = Task.open(task.customerId, next, opts.at)
    const made = await this.ion.create(successor.desiredWeek(), { dryRun: opts.dryRun })
    if (!made.accepted) {
      return { ok: false, taskId: task.id, ionTaskId,
        detail: `closed ${endsOn} but CREATE FAILED — customer has no live task: ${made.detail}`, payload: made.payload }
    }
    if (opts.dryRun) {
      return { ok: true, taskId: task.id, ionTaskId,
        detail: `dry run: would end ${endsOn} and start a successor ${startsOn}`, payload: made.payload }
    }

    // 3. record both, old first: the one-open-per-location rule is the
    //    database's, and it would reject the successor while this one is open.
    const oldBefore = {
        days: Object.fromEntries(task.terms.slots.map((sl) => [String(sl.weekday), sl.techId])),
        frequency: task.terms.slots[0]?.frequency ?? null,
        startsOn: task.terms.startsOn,
        endsOn: task.terms.endsOn,
      }
    task.close(opts.at, endsOn)
    await this.tasks.save(task)
    successor.identify(crypto.randomUUID(), made.ionTaskId!)
    await this.tasks.save(successor)
    // Two facts, because two contracts changed: one ended, one began.
    await this.events?.append([
      {
        aggregate: "task", aggregateId: task.id, type: "TaskUpdated", actor: "task_service",
        participants: [`customer:${task.customerId}`],
        payload: { before: oldBefore, after: { ...oldBefore, endsOn }, source: "app", note: `superseded by ${made.ionTaskId}` },
      },
      {
        aggregate: "task", aggregateId: successor.id!, type: "TaskAdded", actor: "task_service",
        participants: [`customer:${successor.customerId}`],
        payload: { after: {
        days: Object.fromEntries(successor.terms.slots.map((sl) => [String(sl.weekday), sl.techId])),
        frequency: successor.terms.slots[0]?.frequency ?? null,
        startsOn: successor.terms.startsOn,
        endsOn: successor.terms.endsOn,
      }, ionTaskId: successor.ionTaskId, note: `supersedes ${ionTaskId}` },
      },
    ])
    return { ok: true, taskId: successor.id, ionTaskId: successor.ionTaskId,
      detail: `superseded: ${ionTaskId} ends ${endsOn}, ${made.ionTaskId} starts ${startsOn}` }
  }

  /**
   * Run a list through one at a time, collecting what happened.
   *
   * Sequential on purpose: ION is one session behind a browser, and twenty
   * concurrent writes to it is how you get a rate limit or a half-applied
   * batch. Stopping early is not offered either — each row is independent, and
   * a caller needs to know which of twenty landed, not just that one failed.
   */
  async addMany(
    rows: readonly { customerId: number; terms: Terms }[],
    opts: { dryRun?: boolean; at?: string } = {},
  ): Promise<TaskOutcome[]> {
    const out: TaskOutcome[] = []
    for (const row of rows) out.push(await this.addTask(row.customerId, row.terms, opts))
    return out
  }
}
