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

/* -------------------------------- invoices -------------------------------- */

export interface QboInvoiceLine {
  readonly qboItemId: string
  readonly description: string | null
  readonly qty: number
  readonly unitPriceCents: number
  readonly amountCents: number
}

export interface QboInvoiceInput {
  readonly qboCustomerId: string
  /** The document number — RULED: one of the month's ION invoice numbers. */
  readonly docNumber: string
  readonly txnDate: string
  readonly memo: string
  readonly lines: readonly QboInvoiceLine[]
}

export interface CreatedInvoice {
  readonly qboInvoiceId: string
  readonly docNumber: string
  readonly subtotalCents: number
  readonly how: "created" | "already_existed"
}

interface QboInvoiceEntity {
  Id: string
  DocNumber: string
  TotalAmt: number
  Balance?: number
  TxnDate?: string
  CustomerRef: { value: string }
  CustomerMemo?: { value?: string }
  Line: { Amount?: number; DetailType?: string }[]
}

/**
 * The MIRROR — RULED (Carter, 2026-08-03): every write to the system of
 * record updates our cache FROM THE VERIFIED ECHO, inside the write method,
 * so the caller never remembers and the mirror is warm the instant we act.
 * Webhooks/CDC and the self-healer remain the CONVERGENCE path — the echo
 * write is the fast lane, not a second source of truth.
 */
export interface InvoiceMirror {
  invoiceUpserted(echo: {
    qboInvoiceId: string
    docNumber: string
    qboCustomerId: string
    txnDate: string
    totalAmt: number
    balance: number
    memo: string | null
    raw: unknown
  }): Promise<void>
}

export class QboInvoices extends Qbo {
  constructor(minter: QboMinter, private readonly mirror?: InvoiceMirror) {
    super(minter)
  }

  /**
   * Make this invoice exist in QBO, echo-verified and idempotent by
   * DocNumber: a re-run finds the existing document (same customer) and
   * converges instead of double-billing — the unique index of the outside
   * world. The echo must agree line-for-line on the subtotal, or the create
   * is treated as failed even though QBO said 200.
   */
  async createInvoice(inv: QboInvoiceInput): Promise<CreatedInvoice> {
    const existing = await this.query<{ QueryResponse: { Invoice?: QboInvoiceEntity[] } }>(
      `select Id, DocNumber, TotalAmt, CustomerRef from Invoice where DocNumber = '${inv.docNumber.replace(/'/g, "")}'`,
    )
    const found = existing.QueryResponse.Invoice?.[0]
    if (found) {
      if (found.CustomerRef.value !== inv.qboCustomerId) {
        throw new Error(`doc number ${inv.docNumber} already belongs to customer ${found.CustomerRef.value} — refusing to reuse it for ${inv.qboCustomerId}`)
      }
      return { qboInvoiceId: found.Id, docNumber: found.DocNumber, subtotalCents: Math.round(found.TotalAmt * 100), how: "already_existed" }
    }

    const subtotal = inv.lines.reduce((s, l) => s + l.amountCents, 0)
    const body = {
      DocNumber: inv.docNumber,
      TxnDate: inv.txnDate,
      CustomerRef: { value: inv.qboCustomerId },
      CustomerMemo: { value: inv.memo },
      Line: inv.lines.map((l) => ({
        DetailType: "SalesItemLineDetail",
        Amount: l.amountCents / 100,
        Description: l.description ?? undefined,
        SalesItemLineDetail: {
          ItemRef: { value: l.qboItemId },
          Qty: l.qty,
          UnitPrice: l.unitPriceCents / 100,
        },
      })),
    }
    const res = await this.request<{ Invoice: QboInvoiceEntity }>("POST", "/invoice", body)
    const echo = res.Invoice
    if (!echo?.Id) throw new Error(`invoice create returned no Id — unproven, treating as failed`)
    const echoSubtotal = Math.round(
      echo.Line.filter((l) => l.DetailType === "SalesItemLineDetail").reduce((s, l) => s + (l.Amount ?? 0), 0) * 100,
    )
    if (echoSubtotal !== subtotal) {
      throw new Error(`invoice ${echo.Id} echo subtotal ${echoSubtotal} != built ${subtotal} — the document does not say what the ledger says`)
    }
    // The mirror rides the verified echo — inside the write, always.
    await this.mirror?.invoiceUpserted({
      qboInvoiceId: echo.Id,
      docNumber: echo.DocNumber,
      qboCustomerId: inv.qboCustomerId,
      txnDate: echo.TxnDate ?? inv.txnDate,
      totalAmt: echo.TotalAmt,
      balance: echo.Balance ?? echo.TotalAmt,
      memo: inv.memo,
      raw: echo,
    })
    return { qboInvoiceId: echo.Id, docNumber: echo.DocNumber, subtotalCents: echoSubtotal, how: "created" }
  }

  /** The moment-of-truth balance read — fresh from QBO, mirror updated en route. */
  async openBalance(qboInvoiceId: string): Promise<number> {
    const res = await this.query<{ QueryResponse: { Invoice?: QboInvoiceEntity[] } }>(
      `select Id, DocNumber, TotalAmt, Balance, TxnDate, CustomerRef from Invoice where Id = '${qboInvoiceId.replace(/'/g, "")}'`,
    )
    const inv = res.QueryResponse.Invoice?.[0]
    if (!inv) throw new Error(`invoice ${qboInvoiceId} not found in QBO — cannot know its balance`)
    await this.mirror?.invoiceUpserted({
      qboInvoiceId: inv.Id,
      docNumber: inv.DocNumber,
      qboCustomerId: inv.CustomerRef.value,
      txnDate: inv.TxnDate ?? "",
      totalAmt: inv.TotalAmt,
      balance: inv.Balance ?? 0,
      memo: inv.CustomerMemo?.value ?? null,
      raw: inv,
    })
    return Math.round((inv.Balance ?? 0) * 100)
  }
}
