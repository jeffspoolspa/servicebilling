-- Enables techs to edit or delete sign-outs they made earlier *the same day*.
-- Adds updated_at for audit, an auto-bump trigger, UPDATE/DELETE RLS scoped to
-- Eastern-time "today", and an RPC that returns the caller's today rows joined
-- with item display fields.

ALTER TABLE public.inventory_sign_outs
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.inventory_sign_outs_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER inventory_sign_outs_updated_at
  BEFORE UPDATE ON public.inventory_sign_outs
  FOR EACH ROW
  EXECUTE FUNCTION public.inventory_sign_outs_set_updated_at();

-- UPDATE: own rows, created today (Eastern).
CREATE POLICY "tech_update_own_today" ON public.inventory_sign_outs
  FOR UPDATE TO authenticated
  USING (
    employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
    AND signed_out_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
  )
  WITH CHECK (
    employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
  );

-- DELETE: own rows, created today (Eastern).
CREATE POLICY "tech_delete_own_today" ON public.inventory_sign_outs
  FOR DELETE TO authenticated
  USING (
    employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
    AND signed_out_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
  );

-- RPC: list the caller's own sign-outs for today (Eastern), with item display info.
-- SECURITY INVOKER so the existing tech_select_own policy is respected.
CREATE OR REPLACE FUNCTION public.list_my_todays_sign_outs()
RETURNS TABLE (
  id bigint,
  item_id bigint,
  quantity numeric,
  signed_out_at timestamptz,
  updated_at timestamptz,
  item_name text,
  sku text
) LANGUAGE sql SECURITY INVOKER AS $$
  SELECT iso.id, iso.item_id, iso.quantity, iso.signed_out_at, iso.updated_at, i.item_name, i.sku
  FROM public.inventory_sign_outs iso
  JOIN public.items i ON i.id = iso.item_id
  WHERE iso.employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
    AND iso.signed_out_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
  ORDER BY iso.signed_out_at DESC;
$$;
