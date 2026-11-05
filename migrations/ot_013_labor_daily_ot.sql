-- 출퇴근 기록부의 추가근무(OT, over time) 시간 — 매장×일 합계, 정직원(관리자)·메이트 구분. 개인 정보는 저장하지 않는다.
-- 이 열이 채워지는 것은 열 추가 이후에 출퇴근 기록부를 (다시) 올린 날짜부터다.
alter table public.ot_labor_daily add column if not exists mate_ot numeric;
alter table public.ot_labor_daily add column if not exists ft_ot numeric;
