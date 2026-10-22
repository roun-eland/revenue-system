-- 경쟁사 탭 월별 그래프용: 우리 브랜드의 월별 매출·영업 점포 수 (기획자만 호출 가능). 이미 Supabase에 적용됨(2026-10-22).
create or replace function public.demand_own_monthly()
returns table(ym text, sales bigint, stores int, partial boolean)
language plpgsql security definer set search_path = public as $$
declare asof date;
begin
  if not public.ot_is_planner() then raise exception 'planner only'; end if;
  select max(sales_date) into asof from ot_sales_daily where total > 0 and not coalesce(is_closed, false);
  return query
    select to_char(d.sales_date, 'YYYY-MM'), sum(d.total)::bigint, count(distinct d.store_code)::int,
           (to_char(d.sales_date, 'YYYY-MM') = to_char(asof, 'YYYY-MM') and asof < (date_trunc('month', asof) + interval '1 month - 1 day')::date)
    from ot_sales_daily d
    where d.total > 0 and not coalesce(d.is_closed, false)
    group by 1 order by 1;
end $$;
revoke all on function public.demand_own_monthly() from public, anon;
grant execute on function public.demand_own_monthly() to authenticated;
