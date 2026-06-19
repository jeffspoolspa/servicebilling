-- ADR 007: when lead intake resolves a service address to a place_id up front and
-- passes it into create_account, the created service_location must also carry
-- geocode_status='ok' to satisfy the ADR-005 invariant (place_id NOT NULL <=>
-- geocode_status='ok'). create_account composes upsert_service_location but did not
-- forward the geocode status/source, so a place_id-bearing create produced a row
-- with NULL geocode_status (invariant violation). Forward them, derived from
-- whether a place_id was supplied. Signature unchanged (intake is the only caller).

create or replace function maintenance.create_account(
  p_first_name text, p_last_name text, p_email text default null, p_phone text default null,
  p_account_type text default 'residential',
  p_billing_street text default null, p_billing_city text default null,
  p_billing_state text default 'GA', p_billing_zip text default null,
  p_account_name text default null,
  p_service_street text default null, p_service_city text default null,
  p_service_state text default 'GA', p_service_zip text default null,
  p_place_id text default null,
  p_service_lat double precision default null,
  p_service_lng double precision default null
) returns jsonb
language plpgsql
security definer
as $function$
declare
  v_account_id bigint;
  v_display_name text;
  v_location_id bigint;
  v_svc_street text; v_svc_city text; v_svc_state text; v_svc_zip text;
begin
  if p_account_type = 'commercial' then
    v_display_name := coalesce(nullif(p_account_name,''), coalesce(p_last_name,''));
  else
    v_display_name := coalesce(p_last_name,'') || ', ' || coalesce(p_first_name,'');
  end if;

  insert into "Customers"(display_name, account_name, first_name, last_name, email, phone,
                          street, city, state, zip, account_type, is_active)
  values (v_display_name, nullif(p_account_name,''), p_first_name, p_last_name, p_email, p_phone,
          p_billing_street, p_billing_city, p_billing_state, p_billing_zip, p_account_type, true)
  returning id into v_account_id;

  v_svc_street := coalesce(p_service_street, p_billing_street);
  v_svc_city   := coalesce(p_service_city, p_billing_city);
  v_svc_state  := coalesce(p_service_state, p_billing_state);
  v_svc_zip    := coalesce(p_service_zip, p_billing_zip);

  if v_svc_street is not null or p_place_id is not null then
    v_location_id := public.upsert_service_location(
      p_account_id     => v_account_id,
      p_place_id       => p_place_id,
      p_street         => v_svc_street,
      p_city           => v_svc_city,
      p_state          => v_svc_state,
      p_zip            => v_svc_zip,
      p_lat            => p_service_lat,
      p_lng            => p_service_lng,
      p_is_primary     => true,
      -- Maintain the ADR-005 invariant: a stored place_id implies a confirmed rooftop.
      p_geocode_source => case when p_place_id is not null then 'google' end,
      p_geocode_status => case when p_place_id is not null then 'ok' end
    );
  end if;

  return jsonb_build_object('account_id', v_account_id, 'display_name', v_display_name, 'location_id', v_location_id);
end
$function$;
