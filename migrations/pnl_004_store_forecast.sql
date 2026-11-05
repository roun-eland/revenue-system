-- 예상실적 › 매장예측 (2026-11-05): 점장님이 매장별로 직접 예상해 적는 손익 + 계정별 개선 계획
-- 한 줄 = (예상 월, 매장, 계정). amount = 점장 예상 금액(말단 계정), plan = 그 계정 줄의 개선 계획 글.
--   금액은 말단 계정 코드에, 계획 글은 화면에 보이는 줄의 코드에 저장한다 (같은 줄이면 한 행에 같이 들어감).
-- 쓰기 권한: 요청대로 프로필이 있는 로그인 계정이면 누구나 입력·수정·삭제 (기획자·매장 관리자 공용 계정 포함, 비로그인 불가).
--   ⚠ 매장별 잠금은 없다 — 누가 어느 매장 칸이든 고칠 수 있고, 마지막 수정자·시각만 남는다 (updated_by/updated_at).
create table if not exists public.pnl_store_forecast (
  ym text not null,
  store_code text not null,
  account_code text not null,
  amount numeric,
  plan text,
  updated_by uuid default auth.uid(),
  updated_at timestamptz default now(),
  primary key (ym, store_code, account_code)
);
alter table public.pnl_store_forecast enable row level security;
drop policy if exists pnl_sf_read on public.pnl_store_forecast;
create policy pnl_sf_read on public.pnl_store_forecast for select to authenticated using (public.ot_has_profile());
drop policy if exists pnl_sf_ins on public.pnl_store_forecast;
create policy pnl_sf_ins on public.pnl_store_forecast for insert to authenticated with check (public.ot_has_profile());
drop policy if exists pnl_sf_upd on public.pnl_store_forecast;
create policy pnl_sf_upd on public.pnl_store_forecast for update to authenticated using (public.ot_has_profile()) with check (public.ot_has_profile());
drop policy if exists pnl_sf_del on public.pnl_store_forecast;
create policy pnl_sf_del on public.pnl_store_forecast for delete to authenticated using (public.ot_has_profile());
grant select, insert, update, delete on public.pnl_store_forecast to authenticated;

create or replace function public.pnl_store_forecast_touch() returns trigger language plpgsql as $$
begin new.updated_by := auth.uid(); new.updated_at := now(); return new; end $$;
drop trigger if exists pnl_store_forecast_touch on public.pnl_store_forecast;
create trigger pnl_store_forecast_touch before insert or update on public.pnl_store_forecast
  for each row execute function public.pnl_store_forecast_touch();
