# f/z_retired/qbo_sync_v1

Retired v1 QBO sync scripts, superseded by the event-driven QBO cache sync
(qbo_inbox -> drain_qbo_inbox -> refresh_*). Reference only.

- qbo_customer_sync (2026-07-20) — daily full customer pull into public.Customers.
  Replaced by refresh_customer (real-time via webhook->qbo_inbox) + cdc_reconciler
  (drift sweep). Its ADR-005 "re-enable after ShipAddr->service_locations" pause
  note is MOOT: ADR-007 made ION the service-address authority, so the QBO-ShipAddr
  path it waited on no longer exists. Schedule deleted 2026-07-20.
