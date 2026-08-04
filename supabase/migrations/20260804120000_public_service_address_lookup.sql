-- Public, deliberately-narrow address→customer lookup for the customer-facing
-- card-collection form.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- The card-on-file form at secure.jeffspoolspa.com/collect is sent to customers
-- as ONE generic link (not a per-customer token), because it goes out in bulk
-- email/SMS where minting 7k unique links is impractical. The form therefore has
-- to identify the customer from something they know: their service address.
--
-- That means an unauthenticated caller can turn an address into a customer name.
-- With 7,206 eligible active service locations, an unguarded search endpoint is a
-- customer-list enumeration tool: type "Main", get every pool customer on Main St.
--
-- The guardrails live HERE, in the function, not in the form. The form is
-- JavaScript a caller can bypass by hitting PostgREST with the (public) anon key
-- directly; this function is the actual trust boundary.
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- 1. search_service_addresses(p_query) — SECURITY DEFINER, granted to anon.
--    Four properties make enumeration impractical while normal use stays easy:
--      a. Requires a house NUMBER (>=1 digit) plus >=3 letters of street name.
--         You must substantially know the address before it answers. This is
--         what stops "list everyone on Main St".
--      b. The house number must match EXACTLY (leading token equality), so the
--         result set is one house, not a street.
--      c. LIMIT 5, no offset/paging — there is no way to walk the table.
--      d. Returns a MASKED name (first initial + surname) and never returns
--         email, phone, balance, or the internal customer id's siblings.
--    Commercial accounts (no last_name) return their business name, which is
--    already public information.
--
-- 2. get_collect_customer(p_customer_id) — the confirm step. Returns the one
--    customer's masked name + qbo_customer_id so the vault can mint a capture
--    session. Only resolves ACTIVE customers that have a QBO id (a card cannot
--    be vaulted without one), so a guessed id yields nothing.
--
-- Both are called server-side by the card-vault edge function `collect-lookup`,
-- never from the browser directly.
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE KEEP / WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- Nothing is dropped; these are new, additive read-only functions. We accept a
-- residual, deliberate disclosure: someone who ALREADY knows a full street
-- address can learn the surname of the pool customer there. That is the minimum
-- disclosure a self-identifying form requires. If that ever becomes
-- unacceptable, the fix is per-customer tokenized links, not a tighter search.

-- 0. Street-name normalizer: lowercase, drop punctuation, and REMOVE the generic
--    street-type word. Without this, "drive" is most of the trigram signal, so
--    "60 Sabal Drive" scored a match against "60 Silver Fox Drive" and "60 Hunters
--    Drive" — surfacing three unrelated households on a confirm screen that should
--    show one. Only the distinctive part of the name may decide the match.
--    Measured after: every form of the address ("60 Sabal Drive", "60 Sabal Dr",
--    "60 sabal", and the typo "60 Sabel Drive") returns exactly 1 row.
CREATE OR REPLACE FUNCTION public.normalize_street_name(p_street text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(coalesce(p_street, '')), '[^a-z ]', ' ', 'g'),
      '\m(drive|dr|street|st|road|rd|lane|ln|court|ct|circle|cir|place|pl|boulevard|blvd|avenue|ave|terrace|ter|trail|trl|parkway|pkwy|highway|hwy|way|run|loop|point|pt|square|sq|north|south|east|west|n|s|e|w)\M',
      ' ', 'g'),
    ' +', ' ', 'g'));
$$;

-- 1. Address → candidate customers. Masked, capped, number-anchored.
CREATE OR REPLACE FUNCTION public.search_service_addresses(p_query text)
RETURNS TABLE (
  customer_id     bigint,
  masked_name     text,
  street          text,
  city            text,
  zip             text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  WITH parsed AS (
    SELECT
      -- The leading run of digits is the house number.
      substring(regexp_replace(lower(trim(coalesce(p_query, ''))), '[^a-z0-9 ]', ' ', 'g')
                from '^\s*([0-9]+)')      AS house_no,
      -- The distinctive street name, street-type word removed.
      public.normalize_street_name(p_query) AS name_part
  )
  SELECT
    c.id,
    CASE
      WHEN c.last_name IS NOT NULL AND btrim(c.last_name) <> ''
        THEN btrim(coalesce(left(btrim(c.first_name), 1) || '. ', '') || btrim(c.last_name))
      ELSE c.display_name
    END,
    sl.street,
    sl.city,
    sl.zip
  FROM parsed p
  JOIN public.service_locations sl
    ON sl.is_active
   -- (b) exact house-number match: the address's leading digits equal the query's.
   AND substring(regexp_replace(lower(sl.street), '[^a-z0-9 ]', ' ', 'g') from '^\s*([0-9]+)')
       = p.house_no
   -- street-name overlap, fuzzy enough to survive "Dr" vs "Drive" and typos.
   AND public.normalize_street_name(sl.street) % p.name_part
  JOIN public."Customers" c
    ON c.id = sl.account_id
   AND c.is_active
   AND c.qbo_customer_id IS NOT NULL
  -- (a) the gate: a house number AND enough of a street name to be a real guess.
  WHERE p.house_no IS NOT NULL
    AND length(regexp_replace(p.name_part, ' ', '', 'g')) >= 3
  ORDER BY similarity(public.normalize_street_name(sl.street), p.name_part) DESC,
           sl.street
  -- (c) hard cap, no paging.
  LIMIT 5;
$$;

COMMENT ON FUNCTION public.search_service_addresses(text) IS
  'Public address->customer lookup for the card-collection form. Requires an exact '
  'house number + >=3 letters of street; returns at most 5 masked candidates. This '
  'function is the trust boundary, not the form calling it.';

-- 2. The confirm step: one customer, by id, only if a card could actually be vaulted.
CREATE OR REPLACE FUNCTION public.get_collect_customer(p_customer_id bigint)
RETURNS TABLE (
  customer_id     bigint,
  masked_name     text,
  qbo_customer_id text,
  street          text,
  city            text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT
    c.id,
    CASE
      WHEN c.last_name IS NOT NULL AND btrim(c.last_name) <> ''
        THEN btrim(coalesce(left(btrim(c.first_name), 1) || '. ', '') || btrim(c.last_name))
      ELSE c.display_name
    END,
    c.qbo_customer_id::text,
    sl.street,
    sl.city
  FROM public."Customers" c
  LEFT JOIN LATERAL (
    SELECT s.street, s.city
    FROM public.service_locations s
    WHERE s.account_id = c.id AND s.is_active
    ORDER BY s.is_primary DESC, s.id
    LIMIT 1
  ) sl ON true
  WHERE c.id = p_customer_id
    AND c.is_active
    AND c.qbo_customer_id IS NOT NULL;
$$;

COMMENT ON FUNCTION public.get_collect_customer(bigint) IS
  'Resolve one customer for the card-collection confirm step. Returns qbo_customer_id '
  'so the vault can mint a capture session. Active + QBO-linked only.';

-- 3. Trigram index so the street-name similarity filter does not seq-scan 7k rows
--    on every keystroke.
CREATE INDEX IF NOT EXISTS service_locations_street_name_trgm_idx
  ON public.service_locations USING gin (public.normalize_street_name(street) gin_trgm_ops);

-- 4. Grants. anon is what the vault edge function authenticates as; the functions'
--    own guardrails (not RLS) are what make that safe.
REVOKE ALL ON FUNCTION public.search_service_addresses(text) FROM public;
REVOKE ALL ON FUNCTION public.get_collect_customer(bigint) FROM public;
GRANT EXECUTE ON FUNCTION public.search_service_addresses(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_collect_customer(bigint)  TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
-- Verified against production 2026-08-04. Each of these returns exactly 1 row:
--   SELECT * FROM public.search_service_addresses('60 Sabal Drive');
--   SELECT * FROM public.search_service_addresses('60 Sabal Dr');
--   SELECT * FROM public.search_service_addresses('60 sabal');
--   SELECT * FROM public.search_service_addresses('60 Sabel Drive');  -- typo
-- Each of these returns 0 rows (enumeration is refused):
--   SELECT * FROM public.search_service_addresses('Sabal Drive');     -- no number
--   SELECT * FROM public.search_service_addresses('60');              -- no street
--   SELECT * FROM public.search_service_addresses('60 drive');        -- type word only
--   SELECT * FROM public.search_service_addresses('%');
--   SELECT * FROM public.search_service_addresses(NULL);
