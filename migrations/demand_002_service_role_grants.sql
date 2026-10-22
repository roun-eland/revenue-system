-- 수집 Edge Function(service_role)이 demand_* 표를 읽고 쓰도록 권한 부여 (RLS는 service_role이 우회하지만 표 권한은 별도로 필요)
grant select, insert, update, delete on
  public.demand_brands, public.demand_keywords, public.demand_search_monthly,
  public.demand_related, public.demand_trend, public.demand_runs
to service_role;
do $$ declare s text; begin
  for s in select pg_get_serial_sequence('public.'||t, 'id') from unnest(array['demand_brands','demand_keywords','demand_runs']) t where pg_get_serial_sequence('public.'||t, 'id') is not null loop
    execute format('grant usage, select on sequence %s to service_role', s);
  end loop;
end $$;
