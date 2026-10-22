-- 2단계 경쟁사 점포 수 (적용 완료본과 동일): 공정위 브랜드관리번호 연결 + 점포 수 저장 표
alter table public.demand_brands add column if not exists ftc_brand_no text;
update public.demand_brands set ftc_brand_no = v.no
from (values ('샤브올데이','BRD_20230261'),('샤브20','BRD_20180612'),('샤브보트R','BRD_20160771'),('샤브온당','BRD_20220368'),
             ('올웨이즈 샤브','BRD_20250286'),('봄담아','BRD_20210230'),('샤브향','BRD_20213978'),('탕화쿵푸','BRD_20191049')) as v(name, no)
where demand_brands.name = v.name;
create table if not exists public.demand_store_counts (
  brand_id bigint not null references public.demand_brands(id) on delete cascade,
  source text not null check (source in ('ftc','semas')),
  period text not null, area text not null default '전체',
  frcs integer, dms integer, total integer,
  collected_at timestamptz not null default now(),
  primary key (brand_id, source, period, area)
);
alter table public.demand_store_counts enable row level security;
drop policy if exists demand_store_counts_planner on public.demand_store_counts;
create policy demand_store_counts_planner on public.demand_store_counts for all to authenticated using (ot_is_planner()) with check (ot_is_planner());
grant select, insert, update, delete on public.demand_store_counts to authenticated, service_role;
