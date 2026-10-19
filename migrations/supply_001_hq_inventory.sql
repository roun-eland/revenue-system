-- 로운 공급관리 — 본부(법인 물류창고) 재고 스냅샷. 매장 재고(material_usage)와 별개로, 매장이 아직 발주하지 않은 본부 비축분.
-- 열람·업로드는 기획자(planner) 계정만 (매장 관리자 계정에는 보이지 않음). 개인정보 없음.
-- 주 1회 같은 양식으로 업로드 → 같은 기준일(snapshot_date)이 다시 올라오면 그 날짜분을 통째로 교체한다.

create table if not exists hq_inventory (
  id bigint generated always as identity primary key,
  snapshot_date date not null,                 -- 파일의 '오늘날짜' = 재고 기준일
  center text not null,                        -- 보관센터 (식자재_이천 / 식자재_이천_축산 / 국내수탁_일죽_축산 / 직수입부자재_일죽 …)
  category text,                               -- 자재구분(F1): 정상자재 / 출고부진 / 평가감 대상·반영중·완료 / 유통기한 내 소진불가
  main_use text,                               -- 주사용 브랜드 (RU 등)
  material_code text not null,
  material_name text,
  spec text,
  stock_unit text,
  unit_cost numeric,                           -- 원가(재고단위 기준)
  out_6m numeric,                              -- 6개월 출고량
  out_12m numeric,                             -- 12개월 출고량
  stock_qty numeric,                           -- 재고수량 (로트 단위)
  daily_out numeric,                           -- 일평균출고량
  stock_days numeric,                          -- 재고일수 (이 로트 수량 ÷ 일평균출고량)
  stock_amount numeric,                        -- 재고금액
  storage_fee numeric,                         -- 보관비
  expiry_date date,                            -- 유통기한 (없으면 null)
  shelf_days_left numeric,                     -- 유통기한 잔여일수
  gap_days numeric,                            -- 유통기한 − 재고일수 (음수 = 유통기한 내 소진불가)
  unused_fee numeric,                          -- 불용 보관비 청구 예정(원)
  brand_feedback text,                         -- 브랜드 피드백(재고소진방법 / 예상소진완성일 / 기타의견)
  prev_category text,                          -- 전주 자재구분
  received_date date,                          -- 입고일자
  stay_days numeric,                           -- 체류일수
  uploaded_by uuid references auth.users(id),
  uploaded_at timestamptz not null default now()
);

create index if not exists hq_inventory_snap_idx on hq_inventory (snapshot_date, material_code);

alter table hq_inventory enable row level security;

drop policy if exists hq_inventory_read on hq_inventory;
create policy hq_inventory_read on hq_inventory for select to authenticated using (ot_is_planner());
drop policy if exists hq_inventory_write on hq_inventory;
create policy hq_inventory_write on hq_inventory for all to authenticated
  using (ot_is_planner()) with check (ot_is_planner());

grant select, insert, update, delete on hq_inventory to authenticated;

-- 같은 기준일 통째 교체 (삭제+삽입을 한 트랜잭션으로) — 중간에 실패해도 기존 데이터가 남는다.
create or replace function hq_inventory_replace(p_date date, p_rows jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  if not ot_is_planner() then raise exception '기획자 계정만 업로드할 수 있습니다'; end if;
  delete from hq_inventory where snapshot_date = p_date;
  insert into hq_inventory (snapshot_date, center, category, main_use, material_code, material_name, spec, stock_unit,
    unit_cost, out_6m, out_12m, stock_qty, daily_out, stock_days, stock_amount, storage_fee, expiry_date,
    shelf_days_left, gap_days, unused_fee, brand_feedback, prev_category, received_date, stay_days, uploaded_by)
  select p_date, r.center, r.category, r.main_use, r.material_code, r.material_name, r.spec, r.stock_unit,
    r.unit_cost, r.out_6m, r.out_12m, r.stock_qty, r.daily_out, r.stock_days, r.stock_amount, r.storage_fee, r.expiry_date,
    r.shelf_days_left, r.gap_days, r.unused_fee, r.brand_feedback, r.prev_category, r.received_date, r.stay_days, auth.uid()
  from jsonb_to_recordset(p_rows) as r(
    center text, category text, main_use text, material_code text, material_name text, spec text, stock_unit text,
    unit_cost numeric, out_6m numeric, out_12m numeric, stock_qty numeric, daily_out numeric, stock_days numeric,
    stock_amount numeric, storage_fee numeric, expiry_date date, shelf_days_left numeric, gap_days numeric,
    unused_fee numeric, brand_feedback text, prev_category text, received_date date, stay_days numeric);
  get diagnostics n = row_count;
  return n;
end $$;

grant execute on function hq_inventory_replace(date, jsonb) to authenticated;
