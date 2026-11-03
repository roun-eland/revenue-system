-- 예상실적 규칙 엔진용 (2026-11-03): 매장×월×계정 합계, 매장×월 매출, 기타제조경비 기준표
-- 기준표 pnl_fixed_cost = 사용자가 관리하던 매장별 고정 지출 기준표(통신비·소각·청소·방역·리스·대행·유지보수, 월 금액) — 제조 지급수수료(⑨) 추정의 기본값

create or replace function public.gl_monthly_stores(p_from text)
returns table (ym text, store_code text, leaf text, amount numeric)
language sql stable security invoker set search_path = public as $$
  select v.ym, v.store_code, coalesce(m.leaf_code, 'UNMAPPED'), sum(v.amount * coalesce(m.sign, 1))::numeric
  from gl_voucher v
  left join gl_acct_map m on m.acct_code = v.acct_code and m.func = v.func
  where v.part = 'store' and v.ym >= p_from
  group by v.ym, v.store_code, coalesce(m.leaf_code, 'UNMAPPED')
$$;

create or replace function public.store_sales_all(p_from text)
returns table (ym text, store_code text, gross numeric)
language sql stable security invoker set search_path = public as $$
  select to_char(sales_date, 'YYYY-MM'), store_code, sum(sales_total)::numeric
  from store_sales
  where to_char(sales_date, 'YYYY-MM') >= p_from
  group by 1, 2
$$;
grant execute on function public.gl_monthly_stores(text), public.store_sales_all(text) to authenticated;
revoke execute on function public.gl_monthly_stores(text), public.store_sales_all(text) from public, anon;

create table if not exists public.pnl_fixed_cost (
  store_code text not null,
  item       text not null,
  amount     numeric(14,0) not null,
  note       text,
  primary key (store_code, item)
);
alter table public.pnl_fixed_cost enable row level security;
drop policy if exists pnl_fixed_cost_planner on public.pnl_fixed_cost;
create policy pnl_fixed_cost_planner on public.pnl_fixed_cost for all to authenticated using (public.ot_is_planner()) with check (public.ot_is_planner());
grant select, insert, update, delete on public.pnl_fixed_cost to authenticated;
revoke all on public.pnl_fixed_cost from anon;
revoke truncate, references, trigger on public.pnl_fixed_cost from authenticated;
