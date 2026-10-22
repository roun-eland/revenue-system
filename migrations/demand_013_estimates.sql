-- 수요 모니터링: 점포 수·점포당 연매출·가격의 '최신 확인값' (출처·기준일·확인 수준 병기, 사람이 확정)
-- 이미 Supabase에 적용됨(2026-10-22). idempotent.
create table if not exists public.demand_estimates (
  id bigserial primary key,
  brand_id int not null references public.demand_brands(id) on delete cascade,
  metric text not null check (metric in ('stores','avg_sales','price')),
  value numeric,
  unit text,
  as_of date,                       -- 값의 기준일(기사 본문에 적힌 시점, 없으면 기사 날짜)
  source_url text,
  source_title text,
  source_type text not null default 'news' check (source_type in ('official','news','estimate','manual')),
  quote text,                       -- 값이 나온 문장(검증용)
  status text not null default 'candidate' check (status in ('candidate','confirmed','rejected')),
  note text,
  found_at timestamptz not null default now(),
  confirmed_by text,
  confirmed_at timestamptz
);
drop index if exists public.demand_estimates_uniq;
create unique index demand_estimates_uniq on public.demand_estimates (brand_id, metric, source_url, value); -- upsert(onConflict) 용 (url이 없는 수동 입력은 NULL이라 중복 허용)
create index if not exists demand_estimates_brand on public.demand_estimates (brand_id, metric, status);
alter table public.demand_estimates enable row level security;
drop policy if exists demand_estimates_planner on public.demand_estimates;
create policy demand_estimates_planner on public.demand_estimates for all to authenticated using (public.ot_is_planner()) with check (public.ot_is_planner());
grant select, insert, update, delete on public.demand_estimates to authenticated;
grant all on public.demand_estimates to service_role;
grant usage, select on sequence public.demand_estimates_id_seq to authenticated, service_role;
