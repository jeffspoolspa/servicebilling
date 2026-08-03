/**
 * QBO, as one object (ADR 012) — the same shape as ION. ALL QuickBooks
 * communication lives here; no domain logic does.
 *
 * The base class owns auth: access keys are minted by the ONE Windmill script
 * that may touch the ROTATING refresh token (f/qbo/api/get_access_token —
 * refresh-and-save, serialized; two refreshers is how the token burns and the
 * integration dies). The app never refreshes. A 401 re-mints once and retries;
 * callers never see auth exist.
 *
 * QboCustomers owns the customer actions. Its rules:
 *  - a write is proven by the VERIFIED ECHO: QBO's create response returns
 *    the full entity with its Id, and that echo — not a status code — is what
 *    fulfills the promise of a QBO id
 *  - ensure semantics: a duplicate-name refusal (QBO 6240) resolves to the
 *    EXISTING customer by query, so a re-run converges instead of failing
 */

export interface QboKeys {
  access_token: string
  realm_id: string
}

export interface QboMinter {
  mint(force: boolean): Promise<QboKeys>
}

const BASE = "https://quickbooks.api.intuit.com/v3/company"

export abstract class Qbo {
  private keys: QboKeys | null = null

  constructor(protected readonly minter: QboMinter) {}

  /** Authenticated request; one re-mint-and-retry on 401. The only auth door. */
  protected async request<T>(method: "GET" | "POST", path: string, body?: unknown, retried = false): Promise<T> {
    if (!this.keys) this.keys = await this.minter.mint(false)
    const res = await fetch(`${BASE}/${this.keys.realm_id}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.keys.access_token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401 && !retried) {
      this.keys = await this.minter.mint(true)
      return this.request(method, path, body, true)
    }
    const text = await res.text()
    if (!res.ok) {
      const err = new Error(`QBO ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`)
      ;(err as Error & { qboBody?: string }).qboBody = text
      throw err
    }
    return JSON.parse(text) as T
  }

  protected query<T>(q: string): Promise<T> {
    return this.request("GET", `/query?query=${encodeURIComponent(q)}`)
  }
}

/* ------------------------------- customers -------------------------------- */

export interface CustomerFields {
  displayName: string
  givenName: string
  familyName: string
  street: string
  city: string
  state: string
  zip: string
  email: string | null
  phone: string | null
  notes: string
}

export interface CreatedCustomer {
  qboId: string
  /** How the promise was fulfilled — a fresh create's echo, or the existing row. */
  how: "created" | "already_existed"
}

interface QboCustomer {
  Id: string
  DisplayName: string
}

export class QboCustomers extends Qbo {
  /**
   * Make this customer exist in QBO and return its id, echo-verified.
   * Idempotent: QBO enforces unique DisplayName, so a duplicate refusal is
   * resolved to the existing customer rather than surfaced as a failure.
   */
  async createCustomer(f: CustomerFields): Promise<CreatedCustomer> {
    // The resolved SERVICE address is the shipping address — where the truck
    // goes — and with no separate billing address it is copied to BillAddr.
    const addr = { Line1: f.street, City: f.city, CountrySubDivisionCode: f.state, PostalCode: f.zip }
    const body: Record<string, unknown> = {
      DisplayName: f.displayName,
      GivenName: f.givenName,
      FamilyName: f.familyName,
      Notes: f.notes.slice(0, 4000),
      ShipAddr: addr,
      BillAddr: { ...addr },
    }
    if (f.email) body.PrimaryEmailAddr = { Address: f.email }
    if (f.phone) body.PrimaryPhone = { FreeFormNumber: f.phone }  // already canonical (Phone VO)

    try {
      const res = await this.request<{ Customer: QboCustomer }>("POST", "/customer", body)
      if (!res.Customer?.Id) throw new Error(`QBO create returned no Customer.Id for ${f.displayName}`)
      return { qboId: res.Customer.Id, how: "created" }
    } catch (err) {
      // 6240 = duplicate name. The customer already exists — find and return it.
      const text = (err as Error & { qboBody?: string }).qboBody ?? ""
      if (!text.includes("6240")) throw err
      const existing = await this.findByDisplayName(f.displayName)
      if (!existing) throw new Error(`QBO says "${f.displayName}" is a duplicate but a query cannot find it`)
      return { qboId: existing.Id, how: "already_existed" }
    }
  }

  async findByDisplayName(displayName: string): Promise<QboCustomer | null> {
    const q = `SELECT Id, DisplayName FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "\\'")}'`
    const res = await this.query<{ QueryResponse?: { Customer?: QboCustomer[] } }>(q)
    return res.QueryResponse?.Customer?.[0] ?? null
  }
}
