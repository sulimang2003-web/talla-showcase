-- Shop owners may edit their own shop (name, menu, hours...), but never the fields that decide money,
-- visibility or ownership. RLS decides WHICH rows a user can touch; this trigger decides WHICH COLUMNS.
-- Admins (public.is_admin()) and server-side jobs (no auth.uid()) are exempt.

create or replace function public.protect_restaurant_fields()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if (select auth.uid()) is not null and not public.is_admin() then
    if new.is_active is distinct from old.is_active
       or new.commission_rate is distinct from old.commission_rate
       or new.owner_id is distinct from old.owner_id
       or new.featured_until is distinct from old.featured_until
       or new.access_until is distinct from old.access_until
       or new.orders_enabled is distinct from old.orders_enabled
       or new.store_type is distinct from old.store_type
       or new.created_at is distinct from old.created_at then
      raise exception 'not_allowed';
    end if;
    if new.stock_updated_at is distinct from old.stock_updated_at then
      new.stock_updated_at := now();
    end if;
    -- ratings change only through the review RPC, which sets this flag for its own transaction
    if (new.rating_avg is distinct from old.rating_avg or new.rating_count is distinct from old.rating_count)
       and coalesce(current_setting('talla.rating', true), '') <> '1' then
      raise exception 'not_allowed';
    end if;
  end if;
  if new.stock_note is distinct from old.stock_note or new.crowd is distinct from old.crowd then
    new.stock_note := nullif(trim(new.stock_note), '');
    new.stock_updated_at := now();
  end if;
  -- on-duty is for pharmacies only, and lasts one night at most
  if new.store_type is distinct from 'pharmacy' then
    new.on_duty_until := null;
  elsif new.on_duty_until is distinct from old.on_duty_until and new.on_duty_until is not null then
    new.on_duty_until := least(new.on_duty_until, now() + interval '24 hours');
  end if;
  return new;
end $function$;

drop trigger if exists restaurants_protect on public.restaurants;
create trigger restaurants_protect
  before update on public.restaurants
  for each row execute function public.protect_restaurant_fields();

-- Customers only see shops whose access is current.
drop policy if exists "restaurants: public read active" on public.restaurants;
create policy "restaurants: public read active" on public.restaurants for select
  using (is_active and (access_until is null or access_until > now()));

create policy "loyalty_cards: user reads own" on public.loyalty_cards for select using (user_id = (select auth.uid()));
create policy "loyalty_cards: owner reads store" on public.loyalty_cards for select using ((select public.owns_restaurant(restaurant_id)));
