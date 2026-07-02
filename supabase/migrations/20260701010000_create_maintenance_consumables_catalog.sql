-- maintenance.consumables -- the consumable/service ITEM MASTER: one row per distinct
-- consumable, keyed by ion_item_id (ION's exact item id -- present on 100% of
-- consumables_usage rows, 1:1 with item_name). Pairs with maintenance.consumables_usage
-- (the per-visit events) as master <-> events.
--
-- WHY: build_task_billing_periods needs a 100%-coverage price lookup to compute
-- expected_consumable_cents. Pricing off consumables_usage.item_id -> public.items is
-- fragile (item_id went null in June 2026). ion_item_id is stable and complete, so we
-- price by ion_item_id -> this catalog instead. EVERY consumable is priced (no billable
-- flag): labor add-ons (HALF HOUR, SALT CELL CLEAN), algaecide, one-off hardware all get
-- a price -- the ones that don't resolve to a QBO item are priced MANUALLY.
--
-- Prices are the BILLED (QBO) price, so the expected total reconciles against the ION
-- invoice report (= QBO). Seed: 142 distinct items; 106 resolve to a QBO price via the
-- ion_item_id -> item_id -> public.items map ('qbo_items'); the remaining 36 land with a
-- NULL price + 'manual' for hand-pricing.
--
-- No FK from consumables_usage.ion_item_id -> here: a new ION item can arrive before it is
-- catalogued; the builder's unpriced_consumables surfaces any uncatalogued/unpriced item as
-- a finite worklist rather than blocking ingestion.

create table if not exists maintenance.consumables (
  ion_item_id      text primary key,
  item_name        text not null,
  unit_price_cents integer,                          -- billed price per unit; null = needs manual price
  price_source     text not null default 'manual',   -- 'qbo_items' (seeded) | 'manual'
  qbo_item_id      text,                             -- link back to public.items / QBO where known
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table maintenance.consumables is
  'Consumable/service item master (one row per distinct ion_item_id). Price lookup for billing_audit.task_billing_periods.expected_consumable_cents. Pairs with maintenance.consumables_usage.';
comment on column maintenance.consumables.unit_price_cents is
  'Billed (QBO) price per unit, cents. NULL = not yet priced -> shows in task_billing_periods.unpriced_consumables until filled.';

-- seed every distinct consumable; price from the QBO item where the ion_item_id resolves.
insert into maintenance.consumables (ion_item_id, item_name, unit_price_cents, qbo_item_id, price_source)
select k.ion_item_id, k.item_name,
       case when pm.price is not null then round(pm.price * 100)::int end,
       pm.qbo_item_id,
       case when pm.price is not null then 'qbo_items' else 'manual' end
from (
  select ion_item_id, min(item_name) as item_name   -- ion_item_id is 1:1 with item_name
  from maintenance.consumables_usage
  where ion_item_id is not null
  group by ion_item_id
) k
left join lateral (
  select i.price, i.qbo_item_id
  from maintenance.consumables_usage r
  join public.items i on i.id = r.item_id
  where r.ion_item_id = k.ion_item_id and i.price > 0
  order by r.recorded_at desc nulls last
  limit 1
) pm on true
on conflict (ion_item_id) do nothing;   -- idempotent: safe to re-run

-- Manual prices from the ION admin item list (scraped 2026-07-01; keyed by ion_item_id =
-- /admin/itemedit.cfm?id=<ion_item_id>). This is ION's own price list -- the price the ION
-- invoice actually charges. Applied ONLY to items that did NOT auto-link to a QBO price
-- (price_source = 'manual'); the 106 QBO-seeded rows are left untouched so the reconcile can
-- surface any QBO<->ION price drift (a "clean up QBO before syncing" signal). Negative price
-- (Chem Check Discount, -1500) is a discount line that reduces the bill.
update maintenance.consumables c
   set unit_price_cents = p.cents, updated_at = now()
  from (values
  ('1431477',4999),('804382',3199),('1418452',928),('1418453',999),
  ('1418450',3599),('1418451',3599),('1431047',26196),('1495040',899),
  ('1326625',-1500),('1431010',35000),('1482178',2799),('1418454',3099),
  ('1594099',1099),('1594772',4699),('804003',6199),('1431450',1310),
  ('1431475',4900),('1594304',6199),('1559172',1899),('804153',3199),
  ('1595080',2310),('1530870',1699),('1590890',7500),('804745',299),
  ('804746',1299),('804747',1999),('804756',6399),('804832',1299),
  ('1595012',2999),('1431476',7899),('1595618',899),('804992',2099),
  ('1439098',5594),('805107',1599),('805106',2199),('805183',2499),
  ('805187',3499),('1554557',1200),('1554558',2300),('1404874',1199),
  ('1404875',3999),('1404876',2299),('1404877',125),('1404864',2999),
  ('1404865',4214),('1404866',799),('1404867',150),('1404868',2192),
  ('1404863',699),('1404869',499),('1404878',3299),('1404879',2699),
  ('1404882',2199),('1404883',3699),('1404884',975),('1404885',100),
  ('1404887',1299),('1404888',99),('1404889',5999),('1404890',1450),
  ('1404891',299),('1404892',253),('1404893',3399),('1404906',5999),
  ('1404897',8999),('1404898',599),('1404899',899),('1404895',2247),
  ('808065',3000),('1166897',5000),('1404923',3099),('1404924',1799),
  ('1404917',1199),
  -- LCH-50-1101 "1LB LIFE BROMINE BOOSTER": in public.items (id 6364 / qbo 11315 / $18.99)
  -- but the ION usage rows carry the bare SKU as the name with null item_id, so it never
  -- auto-linked. Not in the ION scrape; priced from the item card.
  ('1280901',1899)
) as p(ion_item_id, cents)
 where c.ion_item_id = p.ion_item_id and c.price_source = 'manual';
