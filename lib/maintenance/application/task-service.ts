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

import { Task, type Terms, type TaskGateway, type TaskRepository, type FreshnessSource } from "@/lib/maintenance/domain"

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
  ) {}

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
    await this.tasks.save(task)
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

    // 1. close the old contract in ION
    const closed = await this.ion.update(
      ionTaskId, { ...task.desiredWeek(), endsOn }, { dryRun: opts.dryRun },
    )
    if (!closed.accepted) {
      return { ok: false, taskId: task.id, ionTaskId, detail: `close refused: ${closed.detail}`, payload: closed.payload }
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
    task.close(opts.at, endsOn)
    await this.tasks.save(task)
    successor.identify(crypto.randomUUID(), made.ionTaskId!)
    await this.tasks.save(successor)
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
