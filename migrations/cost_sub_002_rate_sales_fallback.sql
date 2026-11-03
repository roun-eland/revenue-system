-- 월 중에는 store_sales(매출 앱 업로드)가 아직 없고 일별 매출이 ot_sales_daily(생산성)에만 있다 (2026-11-03: store_sales 는 10/31 까지).
-- 비율의 분모(기간 순매출)를 store_sales 로 먼저 잡고, store_sales 에 없는 매장×날짜는 ot_sales_daily(총매출 ÷ 1.1)로 채운다.
-- 부자재(견본비율)와 식자재(원가율) 함수 모두 같은 규칙.
create or replace function public.pnl_store_sub_rate(p_month date)
returns table (store_code text, usage_amount numeric, net_sales numeric, d_from date, d_to date)
language sql stable security invoker set search_path = public as $$
  with r as (select min(period_start) f, max(period_end) t from material_usage_sub where usage_month = p_month),
  u as (select m.store_code, sum(m.actual_usage_amount) amt from material_usage_sub m where m.usage_month = p_month group by 1),
  d as (
    select ss.store_code, ss.sales_date, ss.sales_total / 1.1 net from store_sales ss, r where ss.sales_date between r.f and r.t
    union all
    select o.store_code, o.sales_date, o.total / 1.1 from ot_sales_daily o, r
    where o.sales_date between r.f and r.t
      and not exists (select 1 from store_sales x where x.store_code = o.store_code and x.sales_date = o.sales_date)
  ),
  s as (select store_code, sum(net) net from d group by 1)
  select u.store_code, u.amt, s.net, r.f, r.t from u cross join r left join s on s.store_code = u.store_code
$$;

create or replace function public.pnl_store_cost_rate(p_month date)
returns table (store_code text, usage_amount numeric, net_sales numeric, d_from date, d_to date)
language sql stable security invoker set search_path = public as $$
  with r as (select min(period_start) f, max(period_end) t from material_usage where usage_month = p_month),
  u as (select m.store_code, sum(m.actual_usage_amount) amt from material_usage m where m.usage_month = p_month group by 1),
  d as (
    select ss.store_code, ss.sales_date, ss.sales_total / 1.1 net from store_sales ss, r where ss.sales_date between r.f and r.t
    union all
    select o.store_code, o.sales_date, o.total / 1.1 from ot_sales_daily o, r
    where o.sales_date between r.f and r.t
      and not exists (select 1 from store_sales x where x.store_code = o.store_code and x.sales_date = o.sales_date)
  ),
  s as (select store_code, sum(net) net from d group by 1)
  select u.store_code, u.amt, s.net, r.f, r.t from u cross join r left join s on s.store_code = u.store_code
$$;
grant execute on function public.pnl_store_sub_rate(date), public.pnl_store_cost_rate(date) to authenticated;
revoke execute on function public.pnl_store_sub_rate(date), public.pnl_store_cost_rate(date) from public, anon;
