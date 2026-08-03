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

import type { Customer } from "@/lib/domain/customers"
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

  async onboard(customer: Customer, opts: { dryRun: boolean }): Promise<OnboardOutcome> {
    // A flagged customer never reaches an external system [I-C1]. The factory
    // already refuses outbound; this is the belt for a rehydrated one.
    if (customer.flagged) {
      return { outcome: "refused", reasons: customer.violations.filter((v) => v.blocking).map((v) => `${v.rule}: ${v.detail}`) }
    }

    // The service location is an ENTITY whose identity is the rooftop place
    // id: resolve the address FIRST (our constraints — real rooftop, city
    // required, in service area — or null), then dedup on that identity.
    // Same rooftop -> same row -> same account, exactly. The normalized
    // street comparison is only the fallback for unpinnable addresses.
    const b = customer.billing
    const geo = await this.resolveAddress({ street: b.street, city: b.city, state: b.state, zip: b.zip })
    const address = geo.resolved ? geo.address : null

    const existing = (address ? await this.customers.findByPlaceId(address.place_id) : null)
      ?? (await this.customers.findByStreet(b.street))
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
      const qbo = await this.ensureQbo(existing.accountId, customer, null)
      return { outcome: "already_ours", accountId: existing.accountId, displayName: existing.displayName, qbo: qbo === "deferred" ? "unlinked" : "linked" }
    }

    if (opts.dryRun) {
      return { outcome: "dry_run", wouldCreate: `${customer.displayName} @ ${b.street}, ${b.city}${address ? "" : " (address NOT rooftop-resolvable — will create unpinned)"}` }
    }

    const { accountId } = await this.customers.create(customer, address)
    const qbo = await this.ensureQbo(accountId, customer, address)
    return { outcome: "created", accountId, qbo }
  }

  /** QBO, echo-verified; the stamp writes the fulfilled promise to our row. */
  private async ensureQbo(
    accountId: number,
    customer: Customer,
    address: { street: string; city: string; state: string; zip: string } | null,
  ): Promise<"created" | "already_existed" | "deferred"> {
    const b = customer.billing
    try {
      const r = await this.qbo.createCustomer({
        displayName: customer.displayName,
        givenName: customer.name.first,
        familyName: customer.name.last,
        street: address?.street ?? b.street,
        city: address?.city ?? b.city,
        state: address?.state ?? b.state,
        zip: address?.zip ?? b.zip,
        email: customer.email?.address ?? null,
        phone: customer.phone?.display ?? null,
        notes: "",
      })
      await this.customers.stampQboId(accountId, r.qboId)
      return r.how
    } catch (err) {
      // Honest deferral: the account exists, the QBO id does not — a re-run
      // converges (duplicate DisplayName resolves to the existing customer).
      console.error(`QBO create failed for ${customer.displayName}: ${err instanceof Error ? err.message : err}`)
      return "deferred"
    }
  }
}
