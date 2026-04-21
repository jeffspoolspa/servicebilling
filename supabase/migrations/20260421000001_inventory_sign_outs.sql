-- Manual inventory sign-outs submitted by maintenance techs from /sign-out.
-- Separate from inventory_movements (which mirrors Lou/Zoho) so human-entered
-- records don't collide with sync sources.

CREATE TABLE public.inventory_sign_outs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id   uuid NOT NULL REFERENCES public.employees(id),
  item_id       bigint NOT NULL REFERENCES public.items(id),
  quantity      numeric NOT NULL CHECK (quantity > 0),
  signed_out_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inventory_sign_outs_employee_idx
  ON public.inventory_sign_outs (employee_id, signed_out_at DESC);

CREATE INDEX inventory_sign_outs_item_idx
  ON public.inventory_sign_outs (item_id, signed_out_at DESC);

ALTER TABLE public.inventory_sign_outs ENABLE ROW LEVEL SECURITY;

-- Techs can insert only rows tied to their own employee record.
CREATE POLICY "tech_insert_own" ON public.inventory_sign_outs
  FOR INSERT TO authenticated
  WITH CHECK (
    employee_id IN (
      SELECT id FROM public.employees WHERE auth_user_id = auth.uid()
    )
  );

-- Techs can read only their own submissions.
CREATE POLICY "tech_select_own" ON public.inventory_sign_outs
  FOR SELECT TO authenticated
  USING (
    employee_id IN (
      SELECT id FROM public.employees WHERE auth_user_id = auth.uid()
    )
  );
