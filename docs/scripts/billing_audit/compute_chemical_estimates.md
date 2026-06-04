# f/billing_audit/compute_chemical_estimates

> Status: [active]
> Source: [f/billing_audit/compute_chemical_estimates.py](../../../f/billing_audit/compute_chemical_estimates.py)
> Triggered by: [manual] / [schedule] (after load_month)
> Concurrency: (none) — reads + writes only our DB

## Purpose

Builds the benchmark used to audit whether a maintenance invoice's chemical charge is reasonable. Aggregates historical maintenance invoices into chemical-cost percentiles (p25 / median / p75) by `service_frequency` × calendar month × season, over a trailing 24 months. A full refresh: deletes and rebuilds `billing_audit.chemical_cost_estimates` each run.

Downstream, an invoice whose `chemical_total` falls far outside the percentile band for its frequency+season gets flagged (`audit_flag_level=high/watch`) and held from autopay for review.

## Reads
- `billing_audit.maintenance_invoices` (weekly/biweekly, chemical_total > 0, last 24 months)

## Writes
- `billing_audit.chemical_cost_estimates` (full delete + insert; percentile rows per frequency × month × season)

## In which flows
- [monthly-maintenance-billing](../../flows/monthly-maintenance-billing/index.md) — the chemical-cost audit gate
