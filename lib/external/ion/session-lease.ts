/**
 * Mutual exclusion over the ONE shared ION session.
 *
 * Every ION entry point writes server-side context before it reads — customer
 * priming (customerTabs.cfm), the reports filter chain (set=1), the customer
 * list reset (reset=1). Enumerated 2026-08-05: there is no entry point that
 * does not. So two callers interleaving do not merely collide; one silently
 * reads under the other's context, and a transactions report whose window
 * moved mid-pull writes wrong facts into billing.
 *
 * RENEW ON ACTIVITY, timer as backstop. Each ION call refreshes the lease as a
 * side effect of work already happening, so the common case costs no extra
 * round trips and cannot be starved by a blocked event loop — which a pure
 * timer can, and `reports.ts` parses large documents synchronously. The timer
 * exists only for a long SINGLE call with no intervening activity.
 *
 * Losing the lease mid-work is treated as fatal, not as something to retry
 * through: another holder now owns the session, so anything we do next lands
 * under their context.
 */

export class IonLeaseLost extends Error {}
export class IonLeaseBusy extends Error {
  constructor(readonly heldBy: string | null, readonly heldFor: string | null) {
    super(`ION session held by ${heldBy ?? "?"}${heldFor ? ` (${heldFor})` : ""}`)
  }
}

/** The two calls the lease needs. Postgres via RPC — the app has no PG driver. */
export interface LeaseRpc {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export interface LeaseOptions {
  /** Seconds a lease survives without renewal. Short: a crash frees ION fast. */
  ttlSeconds?: number
  /** Renew when this much of the TTL has elapsed. */
  renewAfterMs?: number
  /** How long to wait for a busy session before giving up. */
  waitMs?: number
  pollMs?: number
}

const DEFAULTS = { ttlSeconds: 60, renewAfterMs: 20_000, waitMs: 0, pollMs: 3_000 }

export class IonSessionLease {
  private lastRenew = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private lost = false

  private constructor(
    private readonly db: LeaseRpc,
    readonly holder: string,
    private readonly ttlSeconds: number,
    private readonly renewAfterMs: number,
  ) {}

  /**
   * Take the session, waiting if someone holds it. Waiting is on ACQUISITION,
   * which is side-effect-free — the loser primes nothing, so there is nothing
   * for it to undo and nothing to livelock over. Only the winner touches ION.
   */
  static async acquire(
    db: LeaseRpc,
    holder: string,
    purpose: string,
    opts: LeaseOptions = {},
  ): Promise<IonSessionLease> {
    const o = { ...DEFAULTS, ...opts }
    const deadline = Date.now() + o.waitMs
    for (;;) {
      const { data, error } = await db.rpc("acquire_session_lease", {
        p_holder: holder, p_purpose: purpose, p_ttl_seconds: o.ttlSeconds,
      })
      if (error) throw new Error(`ion lease acquire failed: ${error.message}`)
      const row = (Array.isArray(data) ? data[0] : data) as
        { acquired: boolean; held_by: string | null; held_for: string | null } | undefined
      if (row?.acquired) {
        const lease = new IonSessionLease(db, holder, o.ttlSeconds, o.renewAfterMs)
        lease.lastRenew = Date.now()
        lease.startBackstop()
        return lease
      }
      if (Date.now() >= deadline) throw new IonLeaseBusy(row?.held_by ?? null, row?.held_for ?? null)
      await new Promise((r) => setTimeout(r, o.pollMs))
    }
  }

  /**
   * Call before every ION request. Cheap: renews only once the TTL is part
   * spent, so a chatty operation pays one UPDATE per renewAfterMs, not one
   * per call.
   */
  async touch(): Promise<void> {
    if (this.lost) throw new IonLeaseLost(`ION lease ${this.holder} was lost`)
    if (Date.now() - this.lastRenew < this.renewAfterMs) return
    await this.renew()
  }

  private async renew(): Promise<void> {
    const { data, error } = await this.db.rpc("renew_session_lease", {
      p_holder: this.holder, p_ttl_seconds: this.ttlSeconds,
    })
    if (error) throw new Error(`ion lease renew failed: ${error.message}`)
    if (data !== true) {
      this.lost = true
      this.stopBackstop()
      throw new IonLeaseLost(
        `ION lease ${this.holder} expired or was taken — stopping before we act under another holder's context`,
      )
    }
    this.lastRenew = Date.now()
  }

  /** Hand it back rather than making the next caller wait out the TTL. */
  async release(): Promise<void> {
    this.stopBackstop()
    if (this.lost) return
    await this.db.rpc("release_session_lease", { p_holder: this.holder })
  }

  /** The one case activity cannot cover: a single call that blocks for minutes. */
  private startBackstop(): void {
    this.timer = setInterval(() => {
      void this.renew().catch(() => {
        /* renew() has already marked the lease lost; touch() will throw. */
      })
    }, this.renewAfterMs)
    // Never hold a process open just to renew.
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }

  private stopBackstop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** Acquire, run, release — release even when the body throws. */
export async function withIonLease<T>(
  db: LeaseRpc,
  holder: string,
  purpose: string,
  fn: (lease: IonSessionLease) => Promise<T>,
  opts: LeaseOptions = {},
): Promise<T> {
  const lease = await IonSessionLease.acquire(db, holder, purpose, opts)
  try {
    return await fn(lease)
  } finally {
    await lease.release()
  }
}
