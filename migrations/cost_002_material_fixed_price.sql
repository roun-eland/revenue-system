-- 축산(우육/돈육 등) 자재의 "진짜 고정단가(원/kg)" — 월별 자재코드 1건.
-- 배경: EATS 자재사용량은 박스규격(예: 35kg/box) 기준 명목수량으로 찍히고, 실제 중량 변동(90~110kg 등)은
-- 월말에 단가를 조정해서 흡수한다(수량 고정·단가 변동). 그래서 이 자재들의 "실사용량수량"은 실제 소비된
-- 무게가 아니다 — 금액(actual_usage_amount)만 정확하다.
-- 이 표에 매장 무관 고정단가를 넣어두면, 인당소비량 계산 시 "금액 ÷ 이 고정단가 = 진짜 소비 무게"로
-- 역산해서 쓴다(계산 로직은 app.js 쪽에서 별도 반영 — 이 테이블은 입력값만 보관).
-- 적용 범위: 인당소비량(그램 추정)에만 쓴다. 실측 원가율은 금액 기준이라 이미 정확해서 영향 없음.

create table if not exists material_fixed_price (
  id bigint generated always as identity primary key,
  usage_month date not null,           -- 그 달 1일로 저장 (예: '2026-09-01')
  material_code text not null,
  material_name text,
  price_per_kg numeric not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (usage_month, material_code)
);

alter table material_fixed_price enable row level security;

drop policy if exists material_fixed_price_read on material_fixed_price;
create policy material_fixed_price_read on material_fixed_price for select to authenticated using (true);

drop policy if exists material_fixed_price_ins_planner on material_fixed_price;
create policy material_fixed_price_ins_planner on material_fixed_price for insert to authenticated with check (ot_is_planner());

drop policy if exists material_fixed_price_upd_planner on material_fixed_price;
create policy material_fixed_price_upd_planner on material_fixed_price for update to authenticated using (ot_is_planner()) with check (ot_is_planner());

drop policy if exists material_fixed_price_del_planner on material_fixed_price;
create policy material_fixed_price_del_planner on material_fixed_price for delete to authenticated using (ot_is_planner());

grant select, insert, update, delete on material_fixed_price to authenticated;
