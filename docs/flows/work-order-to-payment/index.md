# Flow: Work Order → Payment

> Status: [active]
> Kind: [orchestration]
> Verification: [verified] — invoice-origin (two leaders) + subtotal-check confirmed with Carter 2026-05-28; line-by-line code audit of each edge still pending (see [open-questions](open-questions.md))
> Trigger: event — a work order closes in ION and its invoice syncs to QBO; then a human clicks "Charge" (or the auto-processor fires)
> Entities: [Work Order](../../entities/work-order.md), [Invoice](../../entities/invoice.md), [Payment](../../entities/payment.md), [Processing Attempt](../../entities/processing-attempt.md)

**One-line purpose:** take a closed service work order from "closed in ION" to "paid + receipt
emailed + recorded in QBO" — enrich the invoice, charge the card on file, record the payment,
and reflect the result back into the cache.

## Layer 0 — System map placement

| Container | Role in this flow |
|---|---|
| ION | Leader for WO creation **and invoice creation, line items, and `invoice_number`**. Read-only mirror; we never write to ION. |
| QBO | Leader for the invoice's **financial state** (balance, email status, applied payments). Bidirectional. |
| Intuit Payments | Processes the actual card charge. Write-out only. |
| Windmill | Orchestrates pre-processing, the charge cycle, and the backstops. |
| Supabase | Caches WOs + invoices + payment methods; holds the `billing_status` state machines + indicator gates. |
| Gmail | Emails the receipt to the customer. |

Plugs into [SYSTEM_MAP.md](../../SYSTEM_MAP.md). Architecture: [ADR 001](../../adrs/001-platform-architecture.md);
invoice unification [ADR 003](../../adrs/003-unify-invoice-table.md).

## The layers (click in)

- **[Schema contract](schema-contract.md)** — what it reads, writes, and calls; the invoice's two leaders.
- **[Decision map](decision-map.md)** — the three state machines, the indicator gates, and the subtotal drift check.
- **[Flow map](flow-map.md)** — the exact sequence + numbered steps + failure modes + backstops.
- **[Open questions](open-questions.md)** — gaps + deferred edge audits.
