-- 브랜드 월 인건비율 실적(사용자 제공 확정치) — 홈 월별 추이 그래프가 이 값이 있는 달은 계산 대신 이 값을 쓴다.
create table if not exists ot_labor_ratio_actual (
  ym text primary key,
  ratio numeric not null check (ratio > 0 and ratio < 100),
  source text,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
alter table ot_labor_ratio_actual enable row level security;
drop policy if exists ot_labor_ratio_actual_read on ot_labor_ratio_actual;
create policy ot_labor_ratio_actual_read on ot_labor_ratio_actual for select to authenticated using (true);
drop policy if exists ot_labor_ratio_actual_write on ot_labor_ratio_actual;
create policy ot_labor_ratio_actual_write on ot_labor_ratio_actual for all to authenticated using (ot_is_planner()) with check (ot_is_planner());
grant select, insert, update, delete on ot_labor_ratio_actual to authenticated;
-- 2026-01~08: 26.6, 30.8, 29.5, 30.7, 28.8, 31.1, 28.7, 28.4 (%)
