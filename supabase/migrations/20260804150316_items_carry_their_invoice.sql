-- RULED: each billable item is tied to its visit AND its invoice ON ITS
-- OWN. The item's qbo_invoice_id is stamped when the item lands on an
-- issued document (the lock, made explicit per item). Backfill every
-- invoiced month by the same bucket rule the documents split on.
UPDATE billing.billable_items bi
SET qbo_invoice_id = pick.qbo_invoice_id
FROM (
  SELECT bi2.id AS item_id, mi.qbo_invoice_id
  FROM billing.billable_items bi2
  JOIN billing.billing_months bm ON bm.id = bi2.billing_month_id AND bm.invoiced_at IS NOT NULL
  LEFT JOIN maintenance.tasks t ON t.id = bi2.task_id
  JOIN LATERAL (
    SELECT mi.qbo_invoice_id FROM billing.month_invoices mi
    WHERE mi.billing_month_id = bm.id
    ORDER BY (mi.kind = CASE
      WHEN t.category = 'green_pool' THEN 'green'
      WHEN bi2.kind = 'consumable' AND EXISTS (
        SELECT 1 FROM maintenance.task_terms tt
        WHERE tt.task_id = bi2.task_id AND tt.consumables_mode ILIKE '%separate%'
          AND (tt.valid_to IS NULL OR tt.valid_to >= bi2.service_date)
      ) THEN 'consumables'
      ELSE 'service'
    END) DESC
    LIMIT 1
  ) mi ON true
  WHERE bi2.qbo_invoice_id IS NULL
) pick
WHERE bi.id = pick.item_id;
