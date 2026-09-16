-- v_service_revenue_daily: one row per calendar day from 2019-01-01 through
-- the end of the current year, with that day's Service-class revenue and
-- the year's running total. The Service dashboard's tiles, trend, hover,
-- and totals table all read this one surface, so they cannot disagree.
-- Workdays are counted in the app (lib/utils/workdays.ts) from the day
-- column; the view carries no calendar rule.

CREATE OR REPLACE VIEW public.v_service_revenue_daily AS
WITH days AS (
  SELECT d::date AS day
  FROM generate_series(
    DATE '2019-01-01',
    (date_trunc('year', now()) + INTERVAL '1 year - 1 day')::date,
    INTERVAL '1 day') AS d
),
rev AS (
  SELECT completed AS day, sum(sub_total) AS revenue, count(*) AS work_orders
  FROM public.v_revenue_by_month
  WHERE revenue_class = 'Service'
  GROUP BY completed
)
SELECT days.day,
       extract(year FROM days.day)::int AS year,
       COALESCE(rev.revenue, 0)::numeric AS revenue,
       COALESCE(rev.work_orders, 0)::int AS work_orders,
       sum(COALESCE(rev.revenue, 0)) OVER (PARTITION BY extract(year FROM days.day) ORDER BY days.day)::numeric AS cumulative
FROM days
LEFT JOIN rev ON rev.day = days.day;
