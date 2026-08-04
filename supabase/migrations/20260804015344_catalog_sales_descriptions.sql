-- The customer-facing SALES DESCRIPTION is catalog data, cached once from
-- QBO's own Item records (the description that comes with the SKU) — not
-- recomputed from history at every issue. Editable like any catalog fact.
-- Backfilled 2026-08-03 from QBO Items (123 of 125; QUALITY CONTROL set
-- from its one historical line). RULED: the issue step REFUSES any line
-- whose item lacks a description — a blank line reached a customer once.
ALTER TABLE maintenance.labor_items ADD COLUMN description text;
ALTER TABLE maintenance.consumables ADD COLUMN sales_description text;
