-- 부정 비중 = AI가 표본(최대 120건) 항목을 하나씩 보고 센 '부정 의견이 담긴 항목 수' / 표본 수 (적용 완료본과 동일)
alter table public.demand_voice_summary add column if not exists neg_items integer;
alter table public.demand_voice_summary add column if not exists sample_size integer;
