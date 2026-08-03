/**
 * Onboard a customer — the use case as one sentence, callable from ANY caller:
 * a route handler, a script over an acquisition list, an agent, a form.
 *
 * Take a validated draft; refuse it if the factory objected; reuse the
 * account if the service address is already ours (the address-first dedup
 * rule); otherwise create our account through the canonical door and ensure
 * the customer exists in QBO (the billing leader) — best-effort, because the
 * expectation WAL repairs a missed confirmation. The ION link is NOT this
 * service's job: it arrives later via sync + resolver, and task creation is
 * blocked until it does (Customer.blocks).
 *
 * No SQL, no QBO field names, no HTTP — those live behind the two ports.
 */

import { isBlocked, type CustomerDraft } from "@/lib/domain/customers/customer"
import type { ResolvedAddress } from "@/lib/places/resolve"

/* ------------------------------- the ports ------------------------------- */

export interface AccountStore {
  /** Address-first dedup: the active account at this street, if any. */
  findByStreet(street: string): Promise<{ accountId: number; displayName: string | null; qboId: string | null } | null>
  /** Create account + primary service location through the canonical RPCs. */
  create(draft: CustomerDraft, address: ResolvedAddress | null): Promise<{ accountId: number }>
}

export interface BillingDirectory {
  /** Make the customer exist in the billing leader. Idempotent per account. */
  ensureCustomer(accountId: number, draft: CustomerDraft): Promise<"created" | "deferred">
}

export type OnboardOutcome =
  | { outcome: "refused"; reasons: string[] }
  | { outcome: "already_ours"; accountId: number; displayName: string | null; qbo: "linked" | "unlinked" }
  | { outcome: "dry_run"; wouldCreate: string }
  | { outcome: "created"; accountId: number; qbo: "created" | "deferred" }

/* ------------------------------ the service ------------------------------ */

export class OnboardingService {
  constructor(
    private readonly accounts: AccountStore,
    private readonly billing: BillingDirectory,
  ) {}

  async onboard(
    draft: CustomerDraft,
    address: ResolvedAddress | null,
    opts: { dryRun: boolean },
  ): Promise<OnboardOutcome> {
    // The factory's objections are final — this service never overrides them.
    if (isBlocked(draft)) {
      return { outcome: "refused", reasons: draft.violations.filter((v) => v.blocking).map((v) => `${v.rule}: ${v.detail}`) }
    }

    // Never a second active account at one service address (DB-enforced rule;
    // asked here first so the answer is a reuse, not an RPC error).
    const existing = await this.accounts.findByStreet(draft.shape.street)
    if (existing) {
      return {
        outcome: "already_ours",
        accountId: existing.accountId,
        displayName: existing.displayName,
        qbo: existing.qboId ? "linked" : "unlinked",
      }
    }

    if (opts.dryRun) {
      return { outcome: "dry_run", wouldCreate: `${draft.displayName} @ ${draft.shape.street}, ${draft.shape.city}` }
    }

    const { accountId } = await this.accounts.create(draft, address)
    const qbo = await this.billing.ensureCustomer(accountId, draft)
    return { outcome: "created", accountId, qbo }
  }
}
