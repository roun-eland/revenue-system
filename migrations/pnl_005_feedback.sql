-- 예상실적 › 피드백 (2026-11-06): 월말에 "확정 실적 vs 매장(예상) vs 매장예측(점장님 예상)"을 비교한다.
-- ① 예상 스냅샷: 월초에 그 시점의 매장별 예상(매장 탭 값)을 저장해 둔다 — 저장하지 않으면 월말에 다시 계산한 값이라 실적이 섞여 차이가 작게 나온다. 기획자만 저장.
-- ② 차이 원인: 차이가 큰 계정에 대해 매장 담당(점장님)이 적는 글. 매장예측과 같이 로그인 계정 누구나 입력.
create table if not exists public.pnl_store_est_snap (
  ym text not null,
  store_code text not null,
  account_code text not null,
  amount numeric not null,
  snapped_at timestamptz not null default now(),
  primary key (ym, store_code, account_code)
);
alter table public.pnl_store_est_snap enable row level security;
drop policy if exists pnl_snap_read on public.pnl_store_est_snap;
create policy pnl_snap_read on public.pnl_store_est_snap for select to authenticated using (public.ot_has_profile());
drop policy if exists pnl_snap_write on public.pnl_store_est_snap;
create policy pnl_snap_write on public.pnl_store_est_snap for all to authenticated using (public.ot_is_planner()) with check (public.ot_is_planner());
grant select, insert, update, delete on public.pnl_store_est_snap to authenticated;

create table if not exists public.pnl_fb_reason (
  ym text not null,
  store_code text not null,
  account_code text not null,
  reason text,
  updated_by uuid default auth.uid(),
  updated_at timestamptz default now(),
  primary key (ym, store_code, account_code)
);
alter table public.pnl_fb_reason enable row level security;
drop policy if exists pnl_fbr_read on public.pnl_fb_reason;
create policy pnl_fbr_read on public.pnl_fb_reason for select to authenticated using (public.ot_has_profile());
drop policy if exists pnl_fbr_ins on public.pnl_fb_reason;
create policy pnl_fbr_ins on public.pnl_fb_reason for insert to authenticated with check (public.ot_has_profile());
drop policy if exists pnl_fbr_upd on public.pnl_fb_reason;
create policy pnl_fbr_upd on public.pnl_fb_reason for update to authenticated using (public.ot_has_profile()) with check (public.ot_has_profile());
drop policy if exists pnl_fbr_del on public.pnl_fb_reason;
create policy pnl_fbr_del on public.pnl_fb_reason for delete to authenticated using (public.ot_has_profile());
grant select, insert, update, delete on public.pnl_fb_reason to authenticated;

create or replace function public.pnl_fb_reason_touch() returns trigger language plpgsql as $$
begin new.updated_by := auth.uid(); new.updated_at := now(); return new; end $$;
drop trigger if exists pnl_fb_reason_touch on public.pnl_fb_reason;
create trigger pnl_fb_reason_touch before insert or update on public.pnl_fb_reason
  for each row execute function public.pnl_fb_reason_touch();
