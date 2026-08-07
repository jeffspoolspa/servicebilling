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

  /** Raw-body request (multipart uploads). Same auth door, same re-mint. */
  protected async requestRaw(method: "POST", path: string, body: Uint8Array, contentType: string, retried = false): Promise<string> {
    if (!this.keys) this.keys = await this.minter.mint(false)
    const res = await fetch(`${BASE}/${this.keys.realm_id}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.keys.access_token}`, Accept: "application/json", "Content-Type": contentType },
      body: body as unknown as BodyInit,
    })
    if (res.status === 401 && !retried) {
      this.keys = await this.minter.mint(true)
      return this.requestRaw(method, path, body, contentType, true)
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`QBO ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
    return text
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

export type QboInvoiceLine =
  | {
      readonly kind: "item"
      readonly qboItemId: string
      readonly description: string | null
      readonly qty: number
      readonly unitPriceCents: number
      readonly amountCents: number
    }
  /** A description-only line — how the visit-date break reads on the document. */
  | { readonly kind: "text"; readonly text: string }

export interface QboInvoiceInput {
  readonly qboCustomerId: string
  /** The document number — RULED: one of the month's ION invoice numbers. */
  readonly docNumber: string
  readonly txnDate: string
  /** Explicit due date — set when the term-derived date would be wrong
   *  (RULED 2026-08-07: TxnDate = month end for revenue recognition, but
   *  due stays 15 days from CREATION, so the term must not recompute it). */
  readonly dueDate?: string
  readonly memo: string
  /** The document carries its own destination — OUR Customers.email is
   *  authoritative (user edits beat QBO), set as BillEmail at create. */
  readonly billEmail: string | null
  /** QBO Class (Maintenance) — the reporting dimension every maint doc carries. */
  readonly classId: string | null
  /** Sales term (Net 15) — QBO computes DueDate from it. */
  readonly salesTermId: string | null
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
    emailStatus?: string
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
    // QBO doc numbers are unique ACROSS transaction types (error 6140) — a
    // credit memo squatting on the number blocks the create, and the
    // invoice-only check would call it free. Seen live: an office credit
    // memo AUTO-NUMBERED into the ION range took Smiley's 7989377.
    const cmPre = await this.query<{ QueryResponse: { CreditMemo?: { Id: string; DocNumber: string }[] } }>(
      `select Id, DocNumber from CreditMemo where DocNumber = '${inv.docNumber.replace(/'/g, "")}'`,
    )
    const squatter = cmPre.QueryResponse.CreditMemo?.[0]
    if (squatter) {
      throw new Error(
        `doc number ${inv.docNumber} is taken by CREDIT MEMO ${squatter.Id} — rename that credit memo (e.g. CM-${squatter.Id}) and re-run; auto-numbered office documents land in the ION range`,
      )
    }
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

    const subtotal = inv.lines.reduce((s, l) => s + (l.kind === "item" ? l.amountCents : 0), 0)
    const body = {
      DocNumber: inv.docNumber,
      TxnDate: inv.txnDate,
      ...(inv.dueDate ? { DueDate: inv.dueDate } : {}),
      CustomerRef: { value: inv.qboCustomerId },
      CustomerMemo: { value: inv.memo },
      PrivateNote: inv.memo,
      ...(inv.billEmail ? { BillEmail: { Address: inv.billEmail } } : {}),
      ...(inv.classId ? { ClassRef: { value: inv.classId } } : {}),
      ...(inv.salesTermId ? { SalesTermRef: { value: inv.salesTermId } } : {}),
      Line: inv.lines.map((l) =>
        l.kind === "text"
          ? { DetailType: "DescriptionOnly", Description: l.text, DescriptionLineDetail: {} }
          : {
              DetailType: "SalesItemLineDetail",
              Amount: l.amountCents / 100,
              Description: l.description ?? undefined,
              SalesItemLineDetail: {
                ItemRef: { value: l.qboItemId },
                Qty: l.qty,
                // The class rides EVERY line, not just the txn header — QBO
                // ignores the header ClassRef when the company tracks class
                // per row, and this method is the ONE place documents are
                // written, so the rule lives here for every caller.
                ...(inv.classId ? { ClassRef: { value: inv.classId } } : {}),
                // Half-quantity lines round per line; the collapsed sum is
                // the LEDGER's truth (what reconciled against ION), so when
                // qty x unit no longer equals it, omit the rate and let QBO
                // derive it — never ship a 6070, never bend the amount.
                ...(Math.round(l.qty * l.unitPriceCents) === l.amountCents
                  ? { UnitPrice: l.unitPriceCents / 100 }
                  : {}),
              },
            },
      ),
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

  /**
   * Attach a PDF to the invoice (QBO attachable API) — the usage report
   * rides the maintenance service invoice. Idempotent enough for the
   * pipeline: QBO tolerates duplicate attachments; the send is the act.
   */
  async attachPdf(qboInvoiceId: string, filename: string, pdf: Uint8Array, includeOnSend: boolean): Promise<void> {
    const boundary = "jpsb" + Math.random().toString(36).slice(2)
    const meta = JSON.stringify({
      FileName: filename,
      ContentType: "application/pdf",
      // IncludeOnSend is what makes the file ride the /send email — without
      // it the attachment only sits on the QBO record. The caller decides;
      // it is never a blanket.
      AttachableRef: [{ EntityRef: { type: "Invoice", value: qboInvoiceId }, IncludeOnSend: includeOnSend }],
    })
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="file_metadata_01"; filename="attachment.json"\r\nContent-Type: application/json\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file_content_01"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`
    const tail = `\r\n--${boundary}--\r\n`
    const body = new Uint8Array([...new TextEncoder().encode(head), ...pdf, ...new TextEncoder().encode(tail)])
    const text = await this.requestRaw("POST", "/upload", body, `multipart/form-data; boundary=${boundary}`)
    // ECHO PROOF: /upload answers 200 even when the file inside failed —
    // only an Attachable with an Id proves the upload landed.
    const echo = JSON.parse(text) as { AttachableResponse?: { Attachable?: { Id?: string }; Fault?: unknown }[] }
    const first = echo.AttachableResponse?.[0]
    if (!first?.Attachable?.Id) {
      throw new Error(`attachment upload unproven for invoice ${qboInvoiceId}: ${JSON.stringify(first?.Fault ?? echo).slice(0, 300)}`)
    }
  }

  /**
   * Send the invoice by email. The echo (the returned Invoice with
   * EmailStatus) proves it, and the mirror rides it — email_status flips to
   * EmailSent in our cache the moment QBO confirms.
   */
  async sendInvoice(qboInvoiceId: string, sendTo?: string): Promise<void> {
    // QUERY BEFORE SEND: QBO's own EmailStatus is the truth a crashed run
    // consults — if the last run's send landed but our mirror write did
    // not, this converges instead of emailing the customer twice.
    const pre = await this.query<{ QueryResponse: { Invoice?: (QboInvoiceEntity & { EmailStatus?: string })[] } }>(
      `select Id, DocNumber, TotalAmt, Balance, TxnDate, CustomerRef, EmailStatus from Invoice where Id = '${qboInvoiceId.replace(/'/g, "")}'`,
    )
    const existing = pre.QueryResponse.Invoice?.[0]
    if (existing?.EmailStatus === "EmailSent") {
      await this.mirror?.invoiceUpserted({
        qboInvoiceId: existing.Id,
        docNumber: existing.DocNumber,
        qboCustomerId: existing.CustomerRef.value,
        txnDate: existing.TxnDate ?? "",
        totalAmt: existing.TotalAmt,
        balance: existing.Balance ?? 0,
        memo: existing.CustomerMemo?.value ?? null,
        raw: existing,
        emailStatus: "EmailSent",
      })
      return // already sent — converge, no second email
    }

    const res = await this.request<{ Invoice: QboInvoiceEntity & { EmailStatus?: string } }>(
      "POST",
      `/invoice/${qboInvoiceId}/send${sendTo ? `?sendTo=${encodeURIComponent(sendTo)}` : ""}`,
    )
    const echo = res.Invoice
    if (!echo?.Id) throw new Error(`invoice send returned no echo — unproven`)
    if (echo.EmailStatus !== "EmailSent") {
      throw new Error(`invoice ${qboInvoiceId} send echo says EmailStatus=${echo.EmailStatus ?? "?"} — not proven sent`)
    }
    await this.mirror?.invoiceUpserted({
      qboInvoiceId: echo.Id,
      docNumber: echo.DocNumber,
      qboCustomerId: echo.CustomerRef.value,
      txnDate: echo.TxnDate ?? "",
      totalAmt: echo.TotalAmt,
      balance: echo.Balance ?? 0,
      memo: echo.CustomerMemo?.value ?? null,
      raw: echo,
      emailStatus: "EmailSent",
    })
  }

  /**
   * Void an invoice — the correction for a document that should not exist.
   * Echo-verified (the void response carries the voided entity) and the
   * mirror rides it: balance 0, raw updated, so the fold and the UI see
   * the void immediately; the webhook remains convergence.
   */
  /**
   * HARD delete — frees the DocNumber so a later issue can mint the same
   * number fresh (a VOIDED invoice still matches the idempotent
   * create-finder; deletion is the only true retraction). Refuses if the
   * invoice has linked payments or was emailed — those are not retractable.
   */
  async deleteInvoice(qboInvoiceId: string): Promise<void> {
    const cur = await this.request<{ Invoice: QboInvoiceEntity & { SyncToken: string; EmailStatus?: string; LinkedTxn?: { TxnType: string }[] } }>("GET", `/invoice/${qboInvoiceId}`)
    if (cur.Invoice.EmailStatus === "EmailSent") throw new Error(`invoice ${qboInvoiceId} was emailed — void, don't delete`)
    if ((cur.Invoice.LinkedTxn ?? []).some((t) => t.TxnType === "Payment")) throw new Error(`invoice ${qboInvoiceId} has linked payments — not retractable`)
    await this.request("POST", `/invoice?operation=delete`, { Id: qboInvoiceId, SyncToken: cur.Invoice.SyncToken })
  }

  async voidInvoice(qboInvoiceId: string): Promise<void> {
    const cur = await this.request<{ Invoice: QboInvoiceEntity & { SyncToken: string } }>("GET", `/invoice/${qboInvoiceId}`)
    const res = await this.request<{ Invoice: QboInvoiceEntity }>("POST", `/invoice?operation=void`, {
      Id: qboInvoiceId,
      SyncToken: cur.Invoice.SyncToken,
    })
    const echo = res.Invoice
    if (!echo?.Id) throw new Error(`void returned no echo — unproven`)
    await this.mirror?.invoiceUpserted({
      qboInvoiceId: echo.Id,
      docNumber: echo.DocNumber,
      qboCustomerId: echo.CustomerRef.value,
      txnDate: echo.TxnDate ?? "",
      totalAmt: echo.TotalAmt,
      balance: echo.Balance ?? 0,
      memo: echo.CustomerMemo?.value ?? null,
      raw: echo,
    })
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

/* -------------------------------- credits --------------------------------- */

export interface OpenCredit {
  readonly kind: "payment" | "credit_memo"
  readonly id: string
  readonly availableCents: number
  readonly memo: string
}

/**
 * Open maintenance credits — RULED: BOTH open (unapplied) Payments AND
 * CreditMemos with remaining credit, filtered to a 'maint' private note.
 * Application mechanics are ported verbatim from the proven
 * apply_maint_credits script: payment-apply preserves already-linked lines
 * and sparse-updates; credit-memo-apply CREATES a $0 Payment linking the CM
 * and the invoice in one line. Both echo-verified. Idempotency is
 * self-converging by construction: amounts are min(available, open
 * balance), and both sides shrink with each application — a crashed re-run
 * re-reads both and applies only what is still owed.
 */
export class QboCredits extends Qbo {
  async openMaintCredits(qboCustomerId: string): Promise<OpenCredit[]> {
    const cust = qboCustomerId.replace(/'/g, "")
    const out: OpenCredit[] = []

    const pays = await this.query<{ QueryResponse: { Payment?: { Id: string; UnappliedAmt?: number; PrivateNote?: string }[] } }>(
      `select Id, UnappliedAmt, PrivateNote from Payment where CustomerRef = '${cust}'`,
    )
    for (const p of pays.QueryResponse.Payment ?? []) {
      const un = Number(p.UnappliedAmt ?? 0)
      if (un > 0 && (p.PrivateNote ?? "").toLowerCase().includes("maint")) {
        out.push({ kind: "payment", id: p.Id, availableCents: Math.round(un * 100), memo: p.PrivateNote ?? "" })
      }
    }

    const cms = await this.query<{ QueryResponse: { CreditMemo?: { Id: string; RemainingCredit?: number; Balance?: number; PrivateNote?: string }[] } }>(
      `select Id, RemainingCredit, Balance, PrivateNote from CreditMemo where CustomerRef = '${cust}' and Balance > '0'`,
    )
    for (const c of cms.QueryResponse.CreditMemo ?? []) {
      const rem = Number(c.RemainingCredit ?? 0)
      if (rem > 0 && (c.PrivateNote ?? "").toLowerCase().includes("maint")) {
        out.push({ kind: "credit_memo", id: c.Id, availableCents: Math.round(rem * 100), memo: c.PrivateNote ?? "" })
      }
    }
    return out
  }

  /** Apply part of an open Payment to an invoice; echo = the new UnappliedAmt. */
  async applyPaymentToInvoice(paymentId: string, qboInvoiceId: string, cents: number): Promise<{ newUnappliedCents: number }> {
    const cur = await this.request<{ Payment: { Id: string; SyncToken: string; TotalAmt: number; CustomerRef: { value: string }; Line?: { LinkedTxn?: unknown[]; Amount?: number }[] } }>(
      "GET",
      `/payment/${paymentId}`,
    )
    const p = cur.Payment
    const lines = (p.Line ?? []).filter((l) => l.LinkedTxn)
    lines.push({ Amount: cents / 100, LinkedTxn: [{ TxnId: qboInvoiceId, TxnType: "Invoice" }] as unknown[] })
    const res = await this.request<{ Payment: { Id: string; UnappliedAmt?: number } }>("POST", "/payment", {
      Id: p.Id,
      SyncToken: p.SyncToken,
      CustomerRef: p.CustomerRef,
      TotalAmt: p.TotalAmt,
      sparse: true,
      Line: lines,
    })
    if (!res.Payment?.Id) throw new Error(`payment apply returned no echo — unproven`)
    return { newUnappliedCents: Math.round(Number(res.Payment.UnappliedAmt ?? 0) * 100) }
  }

  /** Apply a CreditMemo to an invoice by creating the linking $0 Payment. */
  async applyCreditMemoToInvoice(cmId: string, qboCustomerId: string, qboInvoiceId: string, cents: number, note: string): Promise<{ createdPaymentId: string }> {
    const res = await this.request<{ Payment: { Id: string } }>("POST", "/payment", {
      TotalAmt: 0,
      CustomerRef: { value: qboCustomerId },
      Line: [
        {
          Amount: cents / 100,
          LinkedTxn: [
            { TxnId: qboInvoiceId, TxnType: "Invoice" },
            { TxnId: cmId, TxnType: "CreditMemo" },
          ],
        },
      ],
      PrivateNote: note,
    })
    if (!res.Payment?.Id) throw new Error(`credit-memo apply returned no echo — unproven`)
    return { createdPaymentId: res.Payment.Id }
  }
}

/**
 * The accounting side of a PROCESSED charge — QBO Payments moved the money;
 * this records the Payment entity so the books and the bank feed agree.
 * Body ported verbatim from the proven f/billing/_lib/qbo.py
 * record_qbo_payment: CreditCardPayment.CreditChargeResponse.CCTransId +
 * TxnSource "IntuitPayment" are the AUTO-RECONCILE linkage — QBO ties the
 * Payment to the merchant batch and the deposit matches itself.
 */
export class QboChargePayments extends Qbo {
  /** QBO PaymentMethod ids the live machinery uses (f/billing/_lib/qbo.py). */
  private static METHOD = { card: "21", ach: "20" } as const

  async recordChargePayment(args: {
    qboInvoiceId: string
    amountCents: number
    memo: string
    kind: "card" | "ach"
    chargeRef: string
    paymentRef: string
  }): Promise<{ qboPaymentId: string }> {
    const invId = args.qboInvoiceId.replace(/'/g, "")

    // The invoice names its customer — and its payments. CONVERGENCE scan:
    // if a prior run's create landed but the charge-row save did not, the
    // linked payment whose memo carries this charge id IS our payment.
    const inv = await this.request<{ Invoice: { Id: string; CustomerRef: { value: string }; LinkedTxn?: { TxnId: string; TxnType: string }[] } }>(
      "GET",
      `/invoice/${invId}`,
    )
    const linkedPayments = (inv.Invoice.LinkedTxn ?? []).filter((t) => t.TxnType === "Payment").map((t) => t.TxnId)
    for (const pid of linkedPayments) {
      const p = await this.request<{ Payment: { Id: string; PrivateNote?: string } }>("GET", `/payment/${pid}`)
      if ((p.Payment.PrivateNote ?? "").includes(args.chargeRef)) return { qboPaymentId: p.Payment.Id }
    }

    const amount = args.amountCents / 100
    const res = await this.request<{ Payment: { Id: string; TotalAmt: number } }>("POST", "/payment", {
      CustomerRef: { value: inv.Invoice.CustomerRef.value },
      TotalAmt: amount,
      PaymentMethodRef: { value: QboChargePayments.METHOD[args.kind] },
      PaymentRefNum: args.paymentRef.slice(0, 21),
      TxnDate: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()),
      Line: [{ Amount: amount, LinkedTxn: [{ TxnId: invId, TxnType: "Invoice" }] }],
      PrivateNote: args.memo,
      CreditCardPayment: {
        CreditChargeInfo: { ProcessPayment: true, Amount: amount },
        CreditChargeResponse: { Status: "Completed", CCTransId: args.chargeRef },
      },
      TxnSource: "IntuitPayment",
    })
    if (!res.Payment?.Id) throw new Error("charge payment create returned no echo — unproven")
    if (Math.round(res.Payment.TotalAmt * 100) !== args.amountCents) {
      throw new Error(`charge payment echo mismatch: sent ${args.amountCents} got ${Math.round(res.Payment.TotalAmt * 100)}`)
    }
    return { qboPaymentId: res.Payment.Id }
  }

  /** QBO emails its own receipt for the payment — same send door as invoices. */
  async sendPaymentReceipt(qboPaymentId: string, sendTo: string): Promise<void> {
    await this.request("POST", `/payment/${qboPaymentId.replace(/'/g, "")}/send?sendTo=${encodeURIComponent(sendTo)}`)
  }
}
