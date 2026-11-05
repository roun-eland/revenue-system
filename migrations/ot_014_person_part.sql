-- 사번 → 홀(FOH)/주방(BOH) 대응표 (2026-11-05, 사용자 결정: 이름·연락처는 저장하지 않고 사번만 저장)
-- 출퇴근 기록부를 올릴 때 이 표로 근무 인원을 홀/주방으로 나눠 시간대별로 합산한다. 기획자만 읽고 쓴다.
create table if not exists public.ot_person_part (
  emp_id text primary key,
  part text not null check (part in ('foh', 'boh')),
  kind text not null check (kind in ('mate', 'ft')),
  store_code text,
  updated_at timestamptz default now()
);
alter table public.ot_person_part enable row level security;
drop policy if exists ot_person_part_planner on public.ot_person_part;
create policy ot_person_part_planner on public.ot_person_part for all to authenticated using (public.ot_is_planner()) with check (public.ot_is_planner());
grant select, insert, update, delete on public.ot_person_part to authenticated;

-- 시간대별 근무 인원을 홀/주방으로 나눈 값 (by_hour와 같은 16칸: 8~23시). 합계 − 홀 − 주방 = 구분 못 한 인원
alter table public.ot_labor_daily add column if not exists by_hour_foh numeric[];
alter table public.ot_labor_daily add column if not exists by_hour_boh numeric[];
