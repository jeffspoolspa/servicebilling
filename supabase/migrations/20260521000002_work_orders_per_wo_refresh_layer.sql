-- Adds a per-WO refresh layer to compensate for ION's bulk-report
-- WorkOrderDetail.cfm endpoint silently dropping individual WOs from
-- otherwise-correct result sets — proven empirically with WO 4972018
-- which is present in a human-driven download of the exact same URL
-- but absent from a playwright-driven fetch (same user CARTER ADMIN,
-- same params, off-by-one-row, only this specific WO missing).
--
-- Two parts:
--
-- 1. last_refreshed_at column on public.work_orders. The new
--    f/ION/refresh_stale_work_orders Windmill script picks the oldest
--    last_refreshed_at rows each run and hits ION's per-WO endpoint
--    (workorders/WOStatus.cfm?id=<wo>) for each — that endpoint is
--    not affected by the bulk-report row-drop quirks. Stamp this
--    column on successful refresh.
--
-- 2. (The bulk-sync upsert behavior fix lives in the Windmill flow,
--    NOT in this migration — flow upserts write invoice_number =
--    EXCLUDED.invoice_number unconditionally, which would clobber
--    a refresh-supplied value when the bulk endpoint silently
--    excludes the WO again. The flow's ON CONFLICT clause needs to
--    change to invoice_number = COALESCE(EXCLUDED.invoice_number,
--    work_orders.invoice_number) so a non-NULL value survives a
--    bulk pass that doesn't include the WO. Tracked in the flow
--    update, not here.)

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS last_refreshed_at timestamptz;

COMMENT ON COLUMN public.work_orders.last_refreshed_at IS
  'Set by f/ION/refresh_stale_work_orders when the WO is re-fetched '
  'from ION''s per-WO WOStatus.cfm endpoint. NULL = never refreshed '
  'via that path. The refresh script picks oldest-first to keep the '
  'whole table reasonably fresh.';

-- Index for the refresh script''s selection query
CREATE INDEX IF NOT EXISTS idx_work_orders_stale_refresh
  ON public.work_orders (last_refreshed_at NULLS FIRST)
  WHERE wo_number IS NOT NULL;
