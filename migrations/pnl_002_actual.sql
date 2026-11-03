-- 예상실적: 브랜드 월별 실적 계정값 (2026-11-03) — 기획자만 읽고 쓴다.
-- amount = 원 단위 (받은 값이 백만원 반올림이라 ×1,000,000). account_code = pnl-accounts.js 의 계정 코드.
create table if not exists public.pnl_actual (
  ym           text not null,
  account_code text not null,
  amount       numeric(18,0) not null,
  source       text,
  updated_at   timestamptz not null default now(),
  primary key (ym, account_code)
);

alter table public.pnl_actual enable row level security;
drop policy if exists pnl_actual_planner on public.pnl_actual;
create policy pnl_actual_planner on public.pnl_actual
  for all to authenticated
  using (public.ot_is_planner()) with check (public.ot_is_planner());
grant select, insert, update, delete on public.pnl_actual to authenticated;
revoke all on public.pnl_actual from anon;
revoke truncate, references, trigger on public.pnl_actual from authenticated;
