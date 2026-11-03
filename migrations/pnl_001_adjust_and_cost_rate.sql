-- 예상실적(pnl) — 특이비용 입력 + 매장별 누적 원가율 집계. 기획자 전용. (2026-11-03, Supabase에 이미 적용됨)
create table if not exists pnl_adjust (
  id bigint generated always as identity primary key,
  ym text not null,
  scope text not null,            -- 'brand' | 매장코드(RU0xx)
  account_code text not null,     -- pnl-accounts.js 의 계정 코드(말단 계정)
  amount numeric not null,        -- 원. 그 계정 값에 더해지는 금액 (비용 계정은 +가 비용 증가)
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists pnl_adjust_ym_idx on pnl_adjust (ym);
alter table pnl_adjust enable row level security;
drop policy if exists pnl_adjust_planner on pnl_adjust;
create policy pnl_adjust_planner on pnl_adjust for all to authenticated
  using (ot_is_planner()) with check (ot_is_planner());
grant select, insert, update, delete on pnl_adjust to authenticated;

create or replace function pnl_store_cost_rate(p_month date)
returns table(store_code text, usage_amount numeric, net_sales numeric, d_from date, d_to date)
language sql stable as $$
  with r as (select min(period_start) f, max(period_end) t from material_usage where usage_month = p_month),
  u as (select m.store_code, sum(m.actual_usage_amount) amt from material_usage m where m.usage_month = p_month group by 1),
  s as (select ss.store_code, sum(ss.sales_total) / 1.1 net from store_sales ss, r where ss.sales_date between r.f and r.t group by 1)
  select u.store_code, u.amt, s.net, r.f, r.t from u cross join r left join s on s.store_code = u.store_code
$$;
grant execute on function pnl_store_cost_rate(date) to authenticated;
