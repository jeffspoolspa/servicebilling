# Flow: CDC Reconciliation

> Status: [stub]
> Kind: [orchestration]
> Verification: [stub]
> Entities: [Invoice](../entities/invoice.md), [Payment](../entities/payment.md), [Customer](../entities/customer.md)

## What this flow does

The backstop that catches QBO changes our webhooks dropped, keeping every QBO cache honest. It is driven entirely by [cdc_reconciler](../scripts/service_billing/cdc_reconciler.md) on a 15-minute schedule.

The mechanism (CDC endpoint, cursor, field diffs, inline `refresh_*` upserts, severity tiers) is documented as a sync flow at [qbo-drift-reconciliation](sync/qbo-drift-reconciliation.md). This page exists mainly as the orchestration-level entry point; the detail lives in the sync flow and the script page.

> This is a stub. If this stays a thin pointer to the sync flow, consider collapsing it into [qbo-drift-reconciliation](sync/qbo-drift-reconciliation.md) and redirecting inbound links there.

## Cross-references

- Mechanism: [qbo-drift-reconciliation sync](sync/qbo-drift-reconciliation.md)
- Script: [cdc_reconciler](../scripts/service_billing/cdc_reconciler.md)
- Architecture: [ADR 001](../adrs/001-platform-architecture.md)
