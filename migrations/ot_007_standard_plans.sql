-- 로운 OT — 표준 사용 계획표(F4) 저장: 매장 × 요일유형(평일/주말) × 버전
-- blocks: [{p:파트, r:역할, n:인원번호|null, ft:정직원여부, s:"6-27,30-31"(슬롯 범위, 1=08:00 30분 단위), t:[[업무,시작슬롯,끝슬롯],...]}]
-- 계획표 원본 데이터는 공개 저장소에 두지 않고 DB에만 적재한다(이 파일은 스키마만).

create table if not exists ot_standard_plans (
  id uuid primary key default gen_random_uuid(),
  store_code text not null references ot_stores(code),
  day_type text not null check (day_type in ('weekday','weekend')),
  version int not null default 1,
  effective_ym text not null,                 -- 적용 시작월 'YYYY-MM'
  blocks jsonb not null,
  excluded jsonb,                             -- 전사 시 제외한 행(그림자·오타) 감사용
  source text,
  verified boolean not null default false,    -- 원본 엑셀 합계와 대조 완료 여부
  is_current boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (store_code, day_type, version)
);

alter table ot_standard_plans enable row level security;

create policy ot_standard_plans_read on ot_standard_plans for select to authenticated using (true);
create policy ot_standard_plans_write on ot_standard_plans for all to authenticated
  using (ot_is_planner()) with check (ot_is_planner());

grant select, insert, update, delete on ot_standard_plans to authenticated;
