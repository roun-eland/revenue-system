-- 로운 OT — 직급별 월 직책수당. std_monthly_cost(월 표준 인건비)에 더해지는 별도 항목.
-- 점장 월 30만원(점장수당). ot_grades는 기획자만 조회/수정 가능(RLS)이라 금액이 비-planner에게 노출되지 않는다.

alter table ot_grades add column if not exists allowance int not null default 0;
update ot_grades set allowance = 300000 where grade = '점장';
