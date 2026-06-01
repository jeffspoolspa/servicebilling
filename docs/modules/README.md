# /docs/modules — area indexes

> Status: [active]
> Last updated: 2026-05-28

This folder holds **thin area-index pages**. The actual documentation lives in [/docs/entities/](../entities/), [/docs/flows/](../flows/), and [/docs/scripts/](../scripts/). Module pages just group entities/flows/scripts by business area for "show me everything related to service-billing" browsing.

## Areas

| Area | Status | What it covers |
|---|---|---|
| [service/](service/README.md) | [active] | Per-WO transaction pipeline: invoice creation, classification, payment processing, reconciliation |
| [maintenance/](maintenance/) | [stub] | Recurring pool service: ION operations, autopay, lead intake, tech mobile |
| [card-vault/](card-vault/) | [stub] | Secure card storage |
| [inventory/](inventory/) | [stub] | Item catalog, counts, transfers |
| [admin/](admin/) | [stub] | Config, user roles, sync logs |
| [_external/](_external/) | [external] | Modules owned by other repos (check_buddy, lead-form site) |

## How an area-index page is structured

Each area README is a single page listing:
- Entities owned by this area (linking to `/docs/entities/<name>.md`)
- Flows that primarily live in this area
- Scripts under this area (linking to `/docs/scripts/<area>/`)
- Boundaries — what's adjacent that's NOT in this area

That's it. No tables, no triggers, no routes — those live on the entity / flow / script pages.

If you find yourself writing more than ~80 lines in an area README, you're duplicating content that belongs on entity/flow/script pages. Link instead.
