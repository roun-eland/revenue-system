-- 매장별 특이값(보정시간): 반합 사용 등으로 인건비·근무시간이 달라지는 매장의 월 근무시간 보정. 생산성 계산에서 월 총 근무시간에 더해진다(음수 = 제외).
create table if not exists ot_store_adjust (
  store_code text primary key references ot_stores(code),
  note text,
  adj_hours numeric not null default 0,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
alter table ot_store_adjust enable row level security;
drop policy if exists ot_store_adjust_read on ot_store_adjust;
create policy ot_store_adjust_read on ot_store_adjust for select to authenticated using (true);
drop policy if exists ot_store_adjust_write on ot_store_adjust;
create policy ot_store_adjust_write on ot_store_adjust for all to authenticated using (ot_is_planner()) with check (ot_is_planner());
grant select, insert, update, delete on ot_store_adjust to authenticated;
