create or replace function public.place_order_v6(
  p_restaurant_id uuid, p_address_id uuid, p_items jsonb,
  p_notes text default null, p_coupon_code text default null, p_use_reward boolean default false,
  p_fulfillment text default 'delivery', p_scheduled_for timestamptz default null,
  p_pay_with text default null, p_recipient_name text default null, p_recipient_phone text default null,
  p_tip numeric default 0
) returns uuid
language plpgsql security definer set search_path to ''
as $$
declare
  v_id uuid;
  v_pickup boolean := coalesce(p_fulfillment, 'delivery') = 'pickup';
  v_pay text := nullif(btrim(left(p_pay_with, 40)), '');
  v_rname text := nullif(btrim(left(p_recipient_name, 60)), '');
  v_rphone text := nullif(regexp_replace(coalesce(p_recipient_phone, ''), '[^0-9+]', '', 'g'), '');
  v_tip numeric(12,2) := round(coalesce(p_tip, 0), 2);
  v_step numeric(12,2);
begin
  if v_rname is not null or v_rphone is not null then
    if v_rname is null or v_rphone is null or length(v_rphone) not between 7 and 16 then
      raise exception 'invalid_recipient';
    end if;
  end if;
  if v_tip < 0 or v_tip > 20 then raise exception 'invalid_tip'; end if;
  if v_pickup then v_tip := 0; v_pay := null; end if;

  v_id := public.place_order_v4(p_restaurant_id, p_address_id, p_items, p_notes, p_coupon_code,
                                p_use_reward, p_fulfillment, p_scheduled_for);

  if v_pay is not null or v_rname is not null or v_tip > 0 then
    select syp_round_to into v_step from public.app_settings where id = 1;
    update public.orders set
      pay_with = v_pay, recipient_name = v_rname, recipient_phone = v_rphone,
      tip = v_tip,
      tip_syp = case when v_tip > 0 and exchange_rate is not null
                     then ceil(v_tip * exchange_rate / coalesce(nullif(v_step, 0), 1)) * coalesce(nullif(v_step, 0), 1) end
    where id = v_id;
  end if;
  return v_id;
end $$;

revoke all on function public.place_order_v6(uuid, uuid, jsonb, text, text, boolean, text, timestamptz, text, text, text, numeric) from public, anon;
grant execute on function public.place_order_v6(uuid, uuid, jsonb, text, text, boolean, text, timestamptz, text, text, text, numeric) to authenticated;
