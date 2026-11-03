-- 매장정보 (2026-11-03) — 매장별 기본·임차 정보. 기획자만 읽고 쓴다.
-- rent_rate = 매출 대비 임차료율(%). extra = 나중에 늘어나는 항목(자유 키·값).
create table if not exists public.store_info (
  store_code    text primary key,
  brand         text,
  store_name    text not null,
  biz_site      text,            -- 사업장
  cost_center   text,
  store_type    text,            -- 매장구분
  biz_reg_no    text,
  contract_type text,            -- 계약구분(임대갑/을)
  rent_rate     numeric(5,2),
  area_m2       numeric(8,2),
  seats         integer,
  open_date     date,
  region        text,
  address       text,
  zip           text,
  phone         text,
  extra         jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  updated_by    text
);

alter table public.store_info enable row level security;
drop policy if exists store_info_planner on public.store_info;
create policy store_info_planner on public.store_info
  for all to authenticated
  using (public.ot_is_planner()) with check (public.ot_is_planner());
grant select, insert, update, delete on public.store_info to authenticated;

-- anon·불필요 권한 회수 (Supabase 기본 grant에는 TRUNCATE 등이 붙어 있다)
revoke all on public.store_info from anon;
revoke truncate, references, trigger on public.store_info from authenticated;
