-- 월 1회 자동 수집: pg_cron이 매월 1일 09:00(KST) 수집 함수를 호출한다. (적용 완료본과 동일)
-- 예약 실행 비밀값은 DB 안에서 무작위로 만들어 demand_private에만 보관한다(이 파일에는 없음). anon 키는 공개용 키다.
create extension if not exists pg_net with schema extensions;
create table if not exists public.demand_private (key text primary key, value text not null, created_at timestamptz not null default now());
alter table public.demand_private enable row level security;
revoke all on public.demand_private from anon, authenticated;
grant select on public.demand_private to service_role;
insert into public.demand_private(key, value) values ('cron_secret', encode(extensions.gen_random_bytes(24), 'hex')) on conflict (key) do nothing;
select cron.unschedule(jobid) from cron.job where jobname = 'demand-collect-monthly';
select cron.schedule('demand-collect-monthly', '0 0 1 * *', $job$
  select net.http_post(
    url := 'https://mnqgqgwdoztdbdyhjqyo.supabase.co/functions/v1/demand-collect',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer <프로젝트 anon 키>',
      'x-cron-secret',(select value from public.demand_private where key='cron_secret')),
    body := '{"mode":"search"}'::jsonb, timeout_milliseconds := 150000);
$job$);
