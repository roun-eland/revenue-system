-- 로운 OT — 정직원 맨파워(월별·매장별·직급별 인원). 개인정보(성명·전화번호)는 저장하지 않는다 —
-- 업로드 파일(맨파워 현황 엑셀)을 브라우저에서 읽어 직급별 인원수만 접어서 보낸다.
-- 가장 최근 ym(<= 조회월)의 행이 그 달의 정직원 구성으로 쓰이고, 없으면 기존 8월 실측 시드(OT_STAFF0)로 폴백한다.

create table if not exists ot_staff_roster (
  ym text not null,                                   -- 적용 시작월 'YYYY-MM'
  store_code text not null references ot_stores(code),
  grade text not null check (grade in ('선임점장','점장','부점장','GM','매니저','캡틴','헤드','ST','TM','HIT')),
  headcount int not null check (headcount >= 0),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (ym, store_code, grade)
);

alter table ot_staff_roster enable row level security;

create policy ot_staff_roster_read on ot_staff_roster for select to authenticated using (true);
create policy ot_staff_roster_write on ot_staff_roster for all to authenticated
  using (ot_is_planner()) with check (ot_is_planner());

grant select, insert, update, delete on ot_staff_roster to authenticated;
