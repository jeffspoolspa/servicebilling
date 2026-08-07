import { randomUUID } from "node:crypto"
import type { Tx, UnitOfWork } from "@/lib/domain/kernel"
import { asDb } from "@/lib/infrastructure/db/kysely"
import { PgAggregateRepository } from "@/lib/infrastructure/db/pg-aggregate-repository"
import type { QboWalletSource, WalletMethodSnapshot } from "@/lib/external/qbo/qbo-processor"
import { Instrument } from "@/lib/payments/domain/wallet/instrument"
import { Wallet, type VaultMethod } from "@/lib/payments/domain/wallet/wallet"

/**
 * The Wallet's door. Hydration derives what the domain must never store:
 * consecutive strikes come from billing.charges outcomes at load (ADR 011 —
 * derived, not stamped), so the count cannot disagree with history.
 *
 * Refresh (QBO Payments vault → cache) is TTL-gated here because callers
 * must not be able to route off a stale wallet by forgetting a call. An
 * errored fetch converges NOTHING — it is not an empty wallet.
 *
 * During the coexistence window our row writes fire the frozen legacy
 * triggers (maintain_default_pm keeps is_default for the SQL path;
 * user_deactivation_wins backstops deactivation) — that is intended: one
 * write, both worlds stay true. The triggers die at cutover, not here.
 */

const DEFAULT_MAX_AGE_MINUTES = 15

/** Outcomes counted toward a streak. Anything else (uncertain, pending)
 *  ENDS the walk without counting — an unknown is not a decline, and
 *  auto-disabling a card over a timeout is Judy's bug with a new hat. */
export function consecutiveDeclines(outcomes: string[]): number {
  let strikes = 0
  for (const status of outcomes) {
    if (status === "declined") strikes++
    else break
  }
  return strikes
}

export class PgWalletRepository extends PgAggregateRepository<Wallet> {
  // Matches the legacy emitters' stream for these facts (fn_maintain_default_pm
  // wrote aggregate='customer') so the event log reads as ONE history.
  protected readonly aggregateName = "customer"

  constructor(
    uow: UnitOfWork,
    private readonly vault: QboWalletSource,
    private readonly maxAgeMinutes: number = DEFAULT_MAX_AGE_MINUTES,
  ) {
    super(uow)
  }

  /** Load the wallet — refreshing from QBO first when the cache is stale. */
  async walletFor(qboCustomerId: string): Promise<Wallet> {
    if (await this.isStale(qboCustomerId)) {
      await this.refresh(qboCustomerId)
    }
    return this.uow.execute((tx) => this.hydrate(qboCustomerId, tx))
  }

  /** Hydration without the refresh — read paths that must not call QBO. */
  async cachedWalletFor(qboCustomerId: string): Promise<Wallet> {
    return this.uow.execute((tx) => this.hydrate(qboCustomerId, tx))
  }

  private async hydrate(qboCustomerId: string, tx: Tx): Promise<Wallet> {
    const db = asDb(tx)
    const rows = await db
      .selectFrom("billing.customer_payment_methods")
      .selectAll()
      .where("qbo_customer_id", "=", qboCustomerId)
      .execute()

    // One ordered read covers every instrument's streak; grouped in memory.
    const charges = rows.length
      ? await db
          .selectFrom("billing.charges")
          .select(["customer_payment_method_id", "status"])
          .where("customer_payment_method_id", "in", rows.map((r) => r.id))
          .orderBy("attempted_at", "desc")
          .execute()
      : []
    const outcomesByPm = new Map<string, string[]>()
    for (const c of charges) {
      if (!c.customer_payment_method_id) continue
      const list = outcomesByPm.get(c.customer_payment_method_id) ?? []
      list.push(c.status)
      outcomesByPm.set(c.customer_payment_method_id, list)
    }

    return new Wallet(
      qboCustomerId,
      rows.map(
        (r) =>
          new Instrument({
            id: r.id,
            onFileId: r.qbo_payment_method_id,
            kind: r.type === "ach" ? "ach" : "card",
            brand: r.card_brand,
            lastFour: r.last_four,
            qboCreatedAt: r.qbo_created_at,
            qboActive: r.is_active,
            humanDeactivated:
              r.deactivated_at === null ? null : { by: r.deactivated_by ?? "unknown", at: r.deactivated_at },
            consecutiveDeclines: consecutiveDeclines(outcomesByPm.get(r.id) ?? []),
            autoDisabledAt: r.auto_disabled_at,
          }),
      ),
    )
  }

  private async isStale(qboCustomerId: string): Promise<boolean> {
    return this.uow.execute(async (tx) => {
      const row = await asDb(tx)
        .selectFrom("Customers")
        .select("pm_last_checked_at")
        .where("qbo_customer_id", "=", qboCustomerId)
        .executeTakeFirst()
      if (!row) return true
      if (row.pm_last_checked_at === null) return true
      return Date.now() - new Date(row.pm_last_checked_at).getTime() > this.maxAgeMinutes * 60_000
    })
  }

  private async refresh(qboCustomerId: string): Promise<void> {
    const { methods, errors } = await this.vault.fetch(qboCustomerId)
    if (errors.length > 0) return // not knowing is not knowing — change nothing

    // raw is storage's memory of the processor's answer (UI + audit read it);
    // the domain never sees it, so it rides beside the save, keyed by onFileId.
    this.rawByOnFileId = new Map(methods.map((m) => [m.qboPaymentMethodId, m.raw]))

    const wallet = await this.uow.execute((tx) => this.hydrate(qboCustomerId, tx))
    const at = new Date().toISOString()
    wallet.applySnapshot(methods.map((m) => this.toVaultMethod(m)), at)
    await this.save(wallet)

    await this.uow.execute((tx) =>
      asDb(tx)
        .updateTable("Customers")
        .set({ pm_last_checked_at: at })
        .where("qbo_customer_id", "=", qboCustomerId)
        .execute(),
    )
  }

  private rawByOnFileId = new Map<string, Record<string, unknown>>()

  private toVaultMethod(m: WalletMethodSnapshot): VaultMethod {
    return {
      // identity assignment is mechanics, not a decision: new methods get
      // their row id minted HERE, before the domain ever sees them. For
      // methods the wallet already holds, applySnapshot matches by onFileId
      // and keeps the existing identity — this uuid simply goes unused.
      id: randomUUID(),
      onFileId: m.qboPaymentMethodId,
      kind: m.type === "ach" ? "ach" : "card",
      brand: m.brand,
      lastFour: m.lastFour,
      qboCreatedAt: (m.raw["created"] as string | undefined) ?? null,
    }
  }

  protected async persist(wallet: Wallet, tx: Tx): Promise<void> {
    const db = asDb(tx)
    for (const i of wallet.all()) {
      const raw = this.rawByOnFileId.get(i.onFileId)
      await db
        .insertInto("billing.customer_payment_methods")
        .values({
          id: i.id,
          qbo_customer_id: wallet.id,
          qbo_payment_method_id: i.onFileId,
          type: i.kind === "ach" ? "ach" : "credit_card",
          card_brand: i.brand,
          last_four: i.lastFour,
          is_default: false, // legacy projection; the frozen trigger maintains it
          is_active: i.qboActive && i.humanDeactivated === null,
          raw: JSON.stringify(raw ?? {}),
          qbo_created_at: i.qboCreatedAt,
          auto_disabled_at: i.autoDisabledAt,
          deactivated_at: i.humanDeactivated?.at ?? null,
          deactivated_by: i.humanDeactivated?.by ?? null,
        })
        .onConflict((oc) =>
          oc.columns(["qbo_customer_id", "qbo_payment_method_id"]).doUpdateSet((eb) => ({
            card_brand: eb.ref("excluded.card_brand"),
            last_four: eb.ref("excluded.last_four"),
            is_active: eb.ref("excluded.is_active"),
            // an errored/absent snapshot must not blank storage's memory
            ...(raw !== undefined ? { raw: JSON.stringify(raw) } : {}),
            qbo_created_at: eb.ref("excluded.qbo_created_at"),
            auto_disabled_at: eb.ref("excluded.auto_disabled_at"),
            deactivated_at: eb.ref("excluded.deactivated_at"),
            deactivated_by: eb.ref("excluded.deactivated_by"),
            fetched_at: new Date().toISOString(),
          })),
        )
        .execute()
    }
  }
}
