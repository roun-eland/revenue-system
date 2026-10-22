-- 고객 반응 월 1회 자동 실행 (적용 완료본과 동일). demand_invoke()는 예약 비밀값으로 Edge Function을 호출하는 DB 내부 도우미.
select cron.unschedule(jobid) from cron.job where jobname like 'demand-voice-monthly%';
select cron.schedule('demand-voice-monthly',      '30 0 1 * *', $$ select public.demand_invoke('demand-voice', '{"mode":"all","scope":"prev"}'::jsonb) $$);
select cron.schedule('demand-voice-monthly-b',    '40 0 1 * *', $$ select public.demand_invoke('demand-voice', '{"mode":"summarize","scope":"prev"}'::jsonb) $$);
select cron.schedule('demand-voice-monthly-c',    '50 0 1 * *', $$ select public.demand_invoke('demand-voice', '{"mode":"summarize","scope":"prev"}'::jsonb) $$);
select cron.schedule('demand-voice-monthly-d',    '0 1 1 * *',  $$ select public.demand_invoke('demand-voice', '{"mode":"summarize","scope":"prev"}'::jsonb) $$);
select cron.schedule('demand-voice-monthly-next', '30 0 2 * *', $$ select public.demand_invoke('demand-voice', '{"mode":"summarize","scope":"prev"}'::jsonb) $$);
