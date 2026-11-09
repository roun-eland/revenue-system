-- 예상실적 › 실적 제출 (2026-11-09): 월 실적을 KPI 표(점당매출·식자재원가율·회전율·…)로 정리해 엑셀로 내려받는다. 기획자 전용.
-- ① pnl_submit_input: 자동 계산이 안 되는 칸(고객 대기시간·재방문주기·피크타임 점유율·EBG 통과 점장수·A점장 후보수 등)과 목표 값을 월별로 저장.
-- ② pnl_submit_stats: 기준일까지의 매장별 매출·객수(이번 달 · 전년 같은 기간)와 고객 평점 평균을 한 번에 집계. 매출/객수 표(store_sales)에 아직 안 들어온 날짜는 생산성 일매출(ot_sales_daily)로 채움.

create table if not exists public.pnl_submit_input (
  ym text not null,
  k text not null,                                   -- KPI 키: perstore, food, turn, wait, cycle, peak, same, stores, rating, ebg, acand, labor
  col text not null check (col in ('target', 'actual', 'prev')),
  val numeric,
  updated_by uuid default auth.uid(),
  updated_at timestamptz default now(),
  primary key (ym, k, col)
);
alter table public.pnl_submit_input enable row level security;
drop policy if exists pnl_submit_in_read on public.pnl_submit_input;
create policy pnl_submit_in_read on public.pnl_submit_input for select to authenticated using (public.ot_is_planner());
drop policy if exists pnl_submit_in_write on public.pnl_submit_input;
create policy pnl_submit_in_write on public.pnl_submit_input for all to authenticated using (public.ot_is_planner()) with check (public.ot_is_planner());
grant select, insert, update, delete on public.pnl_submit_input to authenticated;

create or replace function public.pnl_submit_touch() returns trigger language plpgsql as $$
begin new.updated_by := auth.uid(); new.updated_at := now(); return new; end $$;
drop trigger if exists pnl_submit_touch on public.pnl_submit_input;
create trigger pnl_submit_touch before insert or update on public.pnl_submit_input
  for each row execute function public.pnl_submit_touch();

create or replace function public.pnl_submit_stats(p_from date, p_to date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_end date := (date_trunc('month', p_from) + interval '1 month - 1 day')::date;
  v_last date; v_to date; res jsonb;
begin
  if not public.ot_is_planner() then raise exception 'planner only'; end if;
  select max(d) into v_last from (
    select sales_date d from store_sales where sales_date between p_from and v_end and coalesce(sales_total, 0) > 0
    union all
    select sales_date from ot_sales_daily where sales_date between p_from and v_end and coalesce(total, 0) > 0 and not coalesce(is_closed, false)
  ) x;
  v_to := least(coalesce(p_to, v_last, p_from), v_end);
  with cur as (
    select store_code, sales_date, sum(sales_total) s, sum(customers_total) g
      from store_sales where sales_date between p_from and v_to and coalesce(sales_total, 0) > 0 group by 1, 2
    union all
    select o.store_code, o.sales_date, sum(o.total), sum(o.guests)
      from ot_sales_daily o
     where o.sales_date between p_from and v_to and coalesce(o.total, 0) > 0 and not coalesce(o.is_closed, false)
       and not exists (select 1 from store_sales s where s.store_code = o.store_code and s.sales_date = o.sales_date and coalesce(s.sales_total, 0) > 0)
     group by 1, 2
  ), prev as (
    select store_code, sales_date, sum(sales_total) s, sum(customers_total) g
      from store_sales
     where sales_date between (p_from - interval '1 year')::date and (v_to - interval '1 year')::date and coalesce(sales_total, 0) > 0 group by 1, 2
  ), ca as (select store_code, count(*) days, sum(s) sales, sum(g) guests from cur group by 1),
     pa as (select store_code, count(*) days, sum(s) sales, sum(g) guests from prev group by 1)
  select jsonb_build_object(
    'from', p_from, 'to', v_to, 'last_date', v_last,
    'stores', coalesce((select jsonb_agg(jsonb_build_object('store_code', t.store_code, 'seats', t.seats,
        'cur_days', coalesce(ca.days, 0), 'cur_sales', coalesce(ca.sales, 0), 'cur_guests', coalesce(ca.guests, 0),
        'prev_days', coalesce(pa.days, 0), 'prev_sales', coalesce(pa.sales, 0), 'prev_guests', coalesce(pa.guests, 0)) order by t.store_code)
      from (select store_code, seats from store_info) t
      left join ca on ca.store_code = t.store_code left join pa on pa.store_code = t.store_code
      where coalesce(ca.days, 0) > 0 or coalesce(pa.days, 0) > 0), '[]'::jsonb),
    'rating', (select jsonb_build_object('avg', avg(rating), 'n', count(*)) from cx_reviews where sale_date between p_from and v_to and rating is not null)
  ) into res;
  return res;
end $$;
revoke execute on function public.pnl_submit_stats(date, date) from public, anon;
grant execute on function public.pnl_submit_stats(date, date) to authenticated;
