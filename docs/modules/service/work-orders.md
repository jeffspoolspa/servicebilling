# Sub-module: service / work-orders

> Status: [stub]
> Schema: `public.work_orders` (mixed leadership — see entity doc)
> Scripts: `f/ION/work_orders.flow`, `f/service_billing/classify_work_orders*`

## Purpose

The work-order lifecycle: how a unit of field work enters our cache from ION and drives billing. The work order is the origin of the per-WO billing pipeline — a closed WO with an invoice number is what kicks everything off.

> This is a stub. The substance currently lives in the entity + sync-flow docs below.

## Where the detail lives now

- Entity: [Work Order](../../entities/work-order.md)
- Sync flow (inbound): [ion-work-orders](../../flows/sync/ion-work-orders.md)
- Drives: [work-order-to-payment](../../flows/work-order-to-payment/index.md)
