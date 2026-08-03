/**
 * Onboard a customer — the use case as one sentence, callable from ANY caller:
 * a route handler, a script over an acquisition list, an agent, a form.
 *
 * Take a validated draft; refuse it if the factory objected; reuse the
 * account if the service address is already ours (the address-first dedup
 * rule); resolve the service address to a rooftop place id + coordinates;
 * create our account through the canonical door; create the customer in QBO
 * and stamp the echo-verified id onto our row. The ION link is NOT this
 * service's job: it arrives later via sync + resolver, and task creation is
 * blocked until it does (Customer.blocks).
 *
 * Dependencies are the named concrete things, same as PublishService takes
 * IonTasks: the customer repository (our cache), the Qbo object (all QBO
 * communication), and the address resolver (mints place id + geocode).
 */

import { isBlocked, type CustomerDraft } from "@/lib/domain/customers/customer"
import type { QboCustomers } from "@/lib/infrastructure/qbo/qbo"
import type { RawAddress, ResolveResult } from "@/lib/places/resolve"
import type { SupabaseCustomerRepository } from "@/lib/infrastructure/customers/supabase-customer-repository"

export type OnboardOutcome =
  | { outcome: "refused"; reasons: string[] }
  | { outcome: "already_ours"; accountId: number; displayName: string | null; qbo: "linked" | "unlinked" }
  | { outcome: "dry_run"; wouldCreate: string }
  | { outcome: "created"; accountId: number; qbo: "created" | "already_existed" | "deferred" }

export class OnboardingService {
  constructor(
    private readonly customers: SupabaseCustomerRepository,
    private readonly qbo: QboCustomers,
    private readonly resolveAddress: (a: RawAddress) => Promise<ResolveResult>,
  ) {}

  async onboard(draft: CustomerDraft, opts: { dryRun: boolean }): Promise<OnboardOutcome> {
    // The factory's objections are final — this service never overrides them.
    if (isBlocked(draft)) {
      return {
        outcome: "refused",
        reasons: draft.violations.filter((v) => v.blocking).map((v) => `${v.rule}: ${v.detail}`),
      }
    }

    // Never a second active account at one service address (DB-enforced rule;
    // asked here first so the answer is a reuse, not an RPC error).
    const existing = await this.customers.findByStreet(draft.shape.street)
    if (existing) {
      // Reuse — but a reused account with NO QBO id is a half-kept promise
      // (a prior run's deferral). Live re-runs finish the job here, which is
      // what makes deferrals converge instead of accumulating.
      if (existing.qboId || opts.dryRun) {
        return {
          outcome: "already_ours",
          accountId: existing.accountId,
          displayName: existing.displayName,
          qbo: existing.qboId ? "linked" : "unlinked",
        }
      }
      const qbo = await this.ensureQbo(existing.accountId, draft, null)
      return { outcome: "already_ours", accountId: existing.accountId, displayName: existing.displayName, qbo: qbo === "deferred" ? "unlinked" : "linked" }
    }

    if (opts.dryRun) {
      return { outcome: "dry_run", wouldCreate: `${draft.displayName} @ ${draft.shape.street}, ${draft.shape.city}` }
    }

    // Rooftop place id + coordinates, minted here so every caller gets a
    // pinned address without knowing geocoding exists. A miss is not fatal —
    // the nightly geocode backfill repairs it (ADR 007).
    const s = draft.shape
    const geo = await this.resolveAddress({ street: s.street, city: s.city, state: s.state, zip: s.zip })
    const address = geo.resolved ? geo.address : null

    const { accountId } = await this.customers.create(draft, address)
    const qbo = await this.ensureQbo(accountId, draft, address)
    return { outcome: "created", accountId, qbo }
  }

  /** QBO, echo-verified; the stamp writes the fulfilled promise to our row. */
  private async ensureQbo(
    accountId: number,
    draft: CustomerDraft,
    address: { street: string; city: string; state: string; zip: string } | null,
  ): Promise<"created" | "already_existed" | "deferred"> {
    const s = draft.shape
    try {
      const r = await this.qbo.createCustomer({
        displayName: draft.displayName,
        givenName: s.firstName,
        familyName: s.lastName,
        street: address?.street ?? s.street,
        city: address?.city ?? s.city,
        state: address?.state ?? s.state,
        zip: address?.zip ?? s.zip,
        email: s.email,
        phone: s.phone,
        notes: draft.profile.notes.join(" | "),
      })
      await this.customers.stampQboId(accountId, r.qboId)
      return r.how
    } catch (err) {
      // Honest deferral: the account exists, the QBO id does not — a re-run
      // converges (duplicate DisplayName resolves to the existing customer).
      console.error(`QBO create failed for ${draft.displayName}: ${err instanceof Error ? err.message : err}`)
      return "deferred"
    }
  }
}
