import { Kysely, PostgresDialect, type Transaction } from "kysely"
import { Pool } from "pg"
import type { Tx, UnitOfWork } from "@/lib/domain/kernel"
import type { Database } from "./schema"

/**
 * The kernel's opaque Tx, bound to its real type. Repositories downcast with
 * asDb() — the one place the opacity is pierced, so the domain layer never
 * learns what a transaction is made of.
 */
export type DbTx = Transaction<Database>

export function asDb(tx: Tx): DbTx {
  return tx as DbTx
}

/**
 * UnitOfWork over a pg Pool via Kysely. BEGIN → fn → COMMIT, ROLLBACK on
 * throw — Kysely's transaction() does exactly this; we only adapt it to the
 * kernel port.
 *
 * Runs in the WORKER TIER (direct Postgres connection). The Next.js app has
 * no DATABASE_URL on purpose: supabase-js/PostgREST cannot hold a
 * transaction, so aggregate saves don't happen there — reads do.
 */
export class PgUnitOfWork implements UnitOfWork {
  private readonly db: Kysely<Database>

  constructor(pool: Pool) {
    this.db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  }

  async execute<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) => fn(trx))
  }
}
