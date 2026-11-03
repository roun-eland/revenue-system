-- 자재 사용량(부자재) = 견본비 (2026-11-03)
-- 식자재 원가(material_usage)와 섞이지 않도록 같은 양식의 별도 테이블에 저장한다.
-- 견본비율 = 부자재 사용액 ÷ 해당 기간 실매출(순매출) — 원가율(pnl_store_cost_rate)과 같은 방식, 예상실적 매장별 견본비에 반영.
create table if not exists public.material_usage_sub (
  id                   bigint generated always as identity primary key,
  season_id            bigint,
  usage_month          date,
  period_start         date,
  period_end           date,
  store_code           text,
  store_name           text,
  material_code        text,
  material_name        text,
  stock_unit           text,
  spec                 text,
  conversion_factor    numeric,
  prev_stock_qty       numeric,
  prev_stock_amount    numeric,
  received_qty         numeric,
  received_amount      numeric,
  current_stock_qty    numeric,
  current_stock_amount numeric,
  actual_usage_qty     numeric,
  actual_usage_amount  numeric,
  created_at           timestamptz default now()
);
create index if not exists material_usage_sub_period on public.material_usage_sub (period_start, period_end, store_code);
create index if not exists material_usage_sub_month on public.material_usage_sub (usage_month);

alter table public.material_usage_sub enable row level security;
drop policy if exists material_usage_sub_read on public.material_usage_sub;
drop policy if exists material_usage_sub_ins_planner on public.material_usage_sub;
drop policy if exists material_usage_sub_upd_planner on public.material_usage_sub;
drop policy if exists material_usage_sub_del_planner on public.material_usage_sub;
create policy material_usage_sub_read on public.material_usage_sub for select to authenticated using (true);
create policy material_usage_sub_ins_planner on public.material_usage_sub for insert to authenticated with check (public.ot_is_planner());
create policy material_usage_sub_upd_planner on public.material_usage_sub for update to authenticated using (public.ot_is_planner());
create policy material_usage_sub_del_planner on public.material_usage_sub for delete to authenticated using (public.ot_is_planner());
grant select, insert, update, delete on public.material_usage_sub to authenticated;
revoke all on public.material_usage_sub from anon;
revoke truncate, references, trigger on public.material_usage_sub from authenticated;

-- 해당 월(usage_month)의 매장별 부자재 사용액과, 그 월 업로드 기간 전체의 매장 순매출(총매출 ÷ 1.1)
create or replace function public.pnl_store_sub_rate(p_month date)
returns table (store_code text, usage_amount numeric, net_sales numeric, d_from date, d_to date)
language sql stable security invoker set search_path = public as $$
  with r as (select min(period_start) f, max(period_end) t from material_usage_sub where usage_month = p_month),
  u as (select m.store_code, sum(m.actual_usage_amount) amt from material_usage_sub m where m.usage_month = p_month group by 1),
  s as (select ss.store_code, sum(ss.sales_total) / 1.1 net from store_sales ss, r where ss.sales_date between r.f and r.t group by 1)
  select u.store_code, u.amt, s.net, r.f, r.t from u cross join r left join s on s.store_code = u.store_code
$$;
grant execute on function public.pnl_store_sub_rate(date) to authenticated;
revoke execute on function public.pnl_store_sub_rate(date) from public, anon;
