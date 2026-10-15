-- 로운 OT — 정직원 맨파워의 홀(FOH)·주방(BOH) 관리자 인원. 표준표의 "관리자" 칸이 홀 관리자인지 주방 관리자인지 나누는 데 쓴다.
-- ot_staff_roster와 같은 원칙: 성명·전화번호는 저장하지 않고 인원수만 둔다.

create table if not exists ot_staff_roster_side (
  ym text not null,
  store_code text not null references ot_stores(code),
  foh int not null default 0 check (foh >= 0),   -- 홀 관리자(맨파워 현황의 FOH 칸 + 점장)
  boh int not null default 0 check (boh >= 0),   -- 주방 관리자(BOH 칸)
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (ym, store_code)
);

alter table ot_staff_roster_side enable row level security;

drop policy if exists ot_staff_roster_side_read on ot_staff_roster_side;
create policy ot_staff_roster_side_read on ot_staff_roster_side for select to authenticated using (true);
drop policy if exists ot_staff_roster_side_write on ot_staff_roster_side;
create policy ot_staff_roster_side_write on ot_staff_roster_side for all to authenticated
  using (ot_is_planner()) with check (ot_is_planner());

grant select, insert, update, delete on ot_staff_roster_side to authenticated;
