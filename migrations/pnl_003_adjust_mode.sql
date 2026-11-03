-- 특이비용(pnl_adjust)에 고정값 모드 추가 (2026-11-03)
-- mode 'add' = 기존 특이비용(규칙 계산값에 더함) / 'set' = 그 매장의 비용 계정을 입력값으로 대체 (입력하지 않은 비용 계정은 0, 매출만 예측 그대로)
-- 2026-11 신촌 폐점 비용·수지 오픈 비용(사용자 추정 손익)이 'set' 으로 들어 있다 (행은 대화에서 execute_sql 로 입력).
alter table public.pnl_adjust add column if not exists mode text not null default 'add';
alter table public.pnl_adjust drop constraint if exists pnl_adjust_mode_chk;
alter table public.pnl_adjust add constraint pnl_adjust_mode_chk check (mode in ('add','set'));
