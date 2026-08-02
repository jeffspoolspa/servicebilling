/**
 * Customer — the shared reference entity. Billing needs one fact from it that
 * is a RULE rather than a column: whether the pool is residential.
 */

export class Customer {
  /**
   * Commercial iff a company name is filled. QBO is the source of truth for
   * the company field; `account_type` is stale and must not be used. Derived
   * in the constructor so the rule has exactly one home and no caller can
   * disagree with it.
   */
  readonly residential: boolean

  constructor(
    readonly id: number,
    readonly displayName: string | null,
    readonly company: string | null,
  ) {
    this.residential = !(company ?? "").trim()
  }

  get commercial(): boolean {
    return !this.residential
  }
}
