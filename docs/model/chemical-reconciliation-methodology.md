# Chemical Reconciliation — Data Methodology (handoff)

> Status: [active] · 2026-06-10
> Purpose: how to compute, per maintenance tech, **chemicals signed out from the warehouse vs. chemicals used on visits** for a given month + branch. Written so another LLM/analyst can reproduce it for a different presentation.

## 1. The question
For each tech, compare:
- **Signed out** — what they pulled from the warehouse onto their truck (`inventory_sign_outs`).
- **Used / "sold"** — what they recorded applying on pool visits (`consumables_usage`); this is what gets billed.
- **Gap** = used − signed. Positive ⇒ used more than they signed for ⇒ unaccounted.

## 2. Database / connection
- Supabase Postgres, project **`vvprodiuwraceabviyes`**.
- Easiest: run SQL via the Supabase SQL editor or the Supabase MCP (`execute_sql`).
- Direct connection (used by the generator script): pooler host `aws-1-us-east-1.pooler.supabase.com`, port `6543`, db `postgres`, user `postgres.vvprodiuwraceabviyes`. Password is the Windmill **variable `u/carter/supabase`** (resource `u/carter/supabase`); SSL required. Do not hardcode it.

## 3. Where the data lives (tables + key columns)

### Sign-outs — `public.inventory_sign_outs` (one row per item a tech takes)
| column | meaning |
|---|---|
| `employee_id` → `public.employees(id)` | the tech |
| `item_id` (bigint) → `public.items(id)` | the catalog item signed out |
| `quantity` (numeric) | **BULK items: already in base units** (the app multiplies a bag/bucket at sign-out, e.g. one 50‑lb bicarb bag → `quantity = 50`). **Specialty/parts: the package COUNT** (one 2.5‑gal jug → `quantity = 1`). |
| `signed_out_at` (timestamptz) | when |

### Usage ("sales") — `maintenance.consumables_usage` (one row per chemical line per visit)
| column | meaning |
|---|---|
| `visit_id` → `maintenance.visits(id)` | the visit |
| `ion_item_id` (text) | ION catalog id (join key to the alias table) |
| `item_name` (text) | raw ION name, e.g. `SODIUM BICARB 1LB`, `CAL HYPO 50LB` |
| `quantity` (numeric) | **COUNT of the named package** (e.g. `CAL HYPO 50LB` qty 1 = one 50‑lb bucket) |
| `canonical_name` (text) → `ion.chemical_definitions` | normalized concept; **NULL for unmapped/tail items** |
| `base_quantity` (numeric) | `= quantity × alias.to_base_factor` → amount in the concept's **base unit** |

### Visits — `maintenance.visits` (ties usage to tech/date/branch)
`id`, `actual_tech_id` → `public.employees(id)`, `scheduled_date` (date), `is_serviceable`. Tech attribution is `actual_tech_id`.

### Employees / branch — `public.employees`, `public.branches`
`employees`: `id, first_name, last_name, branch_id → branches(id)`.
Brunswick, GA branch_id = **`ef68803e-ba7b-4c1a-a05f-1ba672299b7b`**. (Branch is also encoded in the ION username prefix: `MNT-B`=Brunswick, `MNT-RH`=Richmond Hill, `MNT-C`=Saint Marys. Only Brunswick currently signs out — the other branches have ~0 sign-outs.)

### Canonical chemical list — `ion.chemical_definitions` (25 concepts)
Seeded from the truck sign-out allowlist (`lib/entities/inventory-signout/signout-items.ts`).
`canonical_name` (slug), `display_name`, `category` ('chemical'|'part'), `base_unit`, `display_order` (**1–8 = bulk, 9–16 = specialty, 17–25 = parts**), `cost_per_base_unit`, `price_per_base_unit`.

### Alias map (usage side) — `ion.consumable_aliases`
`ion_item_id` (text, matches `consumables_usage.ion_item_id`), `raw_name`, `canonical_name` → definitions, `to_base_factor` (numeric), `kind` ('chemical'|'part'|'non_item'|'unknown'). Non-mapped ION ids are registered with `canonical_name = NULL` and `kind` `unknown`/`non_item`.

**Sign-out side mapping is NOT in a table** — `inventory_sign_outs.item_id` (a `public.items` id) maps to a concept via the truck list, embedded inline as a VALUES map:
```
item_id → display_order(co):
13698→1 cal_hypo, 13703→2 calcium_chloride, 13735→3 chlorine_tablet, 13874→4 cyanuric_acid,
14654→5 liquid_clarifier_mcb, 15067→6 phosphate_remover_lpe, 15980→7 soda_ash, 15982→8 sodium_bicarb,
13331→9 no_mor_problems, 14030→10 enzyme, 14653→11 liquid_chlorine, 14797→12 muriatic_acid,
14934→13 oxidizer, 15882→14 salt, 15883→15 salt_test_strips, 16624→16 tile_soap,
13729→17 chlorinator_check_valve, 13730→18 chlorinator_control_valve, 13731→19 chlorinator_lid_oring,
13732→20 chlorinator_tubing, 15126→21 polaris_all_purpose_bag, 15127→22 polaris_sweep_hose_clamp,
15128→23 polaris_tail_scrubber, 15215→24 psi_gauge_back_mount, 15216→25 psi_gauge_bottom_mount
```

## 4. Unit model (important)
- **Bulk (display_order 1–8): report in BASE units (lb / oz / tab).**
  - used = `consumables_usage.base_quantity`
  - signed = `inventory_sign_outs.quantity` (already base; factor 1)
- **Specialty (9–16) + parts (17–25): report in PACKAGE / ALIAS units** (the unit techs handle):
  - used = `consumables_usage.quantity` (raw package count)
  - signed = `inventory_sign_outs.quantity` (raw package count)
  - alias unit labels: NMP `qt`, enzyme `qt`, liquid chlorine `jug` (2.5 gal), muriatic `gal`, oxidizer `bottle` (1.5 lb), salt `bag` (40 lb), salt test strips `pack`, tile soap `qt`, parts `ea`.
- `to_base_factor` (package→base, used only to derive `base_quantity` for bulk): 50LB→50, 2.5GAL→2.5, 1OZ→1, 1QT‑liquid→32 (oz), salt 40LB→40, oxidizer 1.5LB→1.5, chlorine tablet 50LB bucket→100 tab *(assumption — verify tabs/bucket)*.

## 5. The exact SQL (month + branch parameters)
Replace `:m0`,`:m1` with the month range and `:branch` with the branch id.

**USED (per tech × concept):**
```sql
WITH defs AS (SELECT canonical_name cn, display_order co FROM ion.chemical_definitions WHERE display_order<=25)
SELECT e.first_name||' '||e.last_name AS tech, df.co,
  round(sum(CASE WHEN df.co<=8 THEN cu.base_quantity ELSE cu.quantity END))::int AS used
FROM maintenance.consumables_usage cu
JOIN maintenance.visits v   ON v.id = cu.visit_id
JOIN public.employees e     ON e.id = v.actual_tech_id AND e.branch_id = :branch
JOIN defs df                ON df.cn = cu.canonical_name
WHERE v.scheduled_date BETWEEN :m0 AND :m1
GROUP BY 1,2;
```

**SIGNED (per tech × concept):**
```sql
WITH im(item_id,co) AS (VALUES (13698::bigint,1),(13703,2),(13735,3),(13874,4),(14654,5),(15067,6),
  (15980,7),(15982,8),(13331,9),(14030,10),(14653,11),(14797,12),(14934,13),(15882,14),(15883,15),(16624,16),
  (13729,17),(13730,18),(13731,19),(13732,20),(15126,21),(15127,22),(15128,23),(15215,24),(15216,25))
SELECT e.first_name||' '||e.last_name AS tech, im.co, round(sum(so.quantity))::int AS signed
FROM public.inventory_sign_outs so
JOIN im ON im.item_id = so.item_id
JOIN public.employees e ON e.id = so.employee_id AND e.branch_id = :branch
WHERE so.signed_out_at::date BETWEEN :m0 AND :m1
GROUP BY 1,2;
```
Join the two on (tech, co); `gap = used − signed`. Join `ion.chemical_definitions` on `display_order = co` for name/unit/price. To show **all items per tech regardless of activity**, cross-join each tech with all 25 `display_order`s and LEFT JOIN the sums (coalesce to 0).

**Visit count (denominator):**
```sql
SELECT count(*) FROM maintenance.visits v JOIN public.employees e ON e.id=v.actual_tech_id
WHERE e.branch_id=:branch AND v.scheduled_date BETWEEN :m0 AND :m1
  AND e.first_name=... AND e.last_name=...;
```

## 6. Dollar valuation (optional)
`value = amount × ion.chemical_definitions.cost_per_base_unit` (or `price_per_base_unit`). For specialty in package units, multiply package count × per-base-unit price × package size, or value off base_quantity. **Caveat:** `liquid_chlorine` cost in `public.items` is bad ($0.01/2.5gal) so the cost column understates it — retail price is fine.

## 7. Caveats / gotchas
- **Adoption, not theft:** only Brunswick signs out; high-volume liquids (liquid chlorine, salt) are barely signed out → big "gaps" there are a process gap.
- **Tail items are excluded:** chemicals not in the 25-item list (DICHLOR, LP‑MAX, LIQUID SHOCK, stabilizers, algaecides, SALT CELL CLEAN, etc.) have `canonical_name = NULL` (`kind='unknown'`) and won't appear — tech usage of them is undercounted. Map them into `ion.chemical_definitions` + `ion.consumable_aliases` if you need them.
- **Non-items:** `Chem Check Discount (Maintenance)` and `HALF HOUR MAINTENANCE` are `kind='non_item'` (billing lines, not chemicals).
- **Timing (this report = simple month totals).** A more accurate method is **refill cycles**: order each bulk chemical's sign-outs by date and match usage from one sign-out to the next; treat the most recent (open) bucket as in-progress and exclude it — this removes false "over-signed" gaps from buckets not yet drawn down.

## 8. Artifacts in this repo
- Report: `docs/model/chemical-reconciliation.html` (per-tech tabs, signed vs used, all 25 items).
- Generator: `/tmp/gen_chem_recon.py` (pg8000 → pooler; creds via env `PGUSER/PGPASSWORD`; edit `M0/M1/MLABEL` + `BRANCH` to change month/branch; re-run to regenerate).
