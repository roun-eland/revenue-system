-- 3단계 고객 반응: 원문 조각(임시 보관)과 월별 요약(영구 보관) (적용 완료본과 동일)
-- 원문(raw)은 유튜브 API 정책(비인증 데이터 30일 초과 보관 금지)에 맞춰 28일 지나면 자동 삭제한다. 요약만 남긴다.
create table if not exists public.demand_voice_raw (
  id bigint generated always as identity primary key,
  brand_id bigint not null references public.demand_brands(id) on delete cascade,
  ym text not null,
  source text not null check (source in ('youtube_video','youtube_comment','blog','cafe','news')),
  title text, snippet text, url text not null, posted_at timestamptz, metric jsonb,
  collected_at timestamptz not null default now(),
  unique (brand_id, source, url)
);
create index if not exists demand_voice_raw_brand_ym on public.demand_voice_raw (brand_id, ym);
create table if not exists public.demand_voice_summary (
  brand_id bigint not null references public.demand_brands(id) on delete cascade,
  ym text not null,
  n_items integer not null default 0,
  sources jsonb not null default '{}'::jsonb,
  positives jsonb not null default '[]'::jsonb,
  negatives jsonb not null default '[]'::jsonb,
  features jsonb not null default '[]'::jsonb,
  flags jsonb not null default '[]'::jsonb,
  headline text, model text,
  created_at timestamptz not null default now(),
  primary key (brand_id, ym)
);
alter table public.demand_voice_raw enable row level security;
alter table public.demand_voice_summary enable row level security;
drop policy if exists demand_voice_raw_planner on public.demand_voice_raw;
create policy demand_voice_raw_planner on public.demand_voice_raw for all to authenticated using (ot_is_planner()) with check (ot_is_planner());
drop policy if exists demand_voice_summary_planner on public.demand_voice_summary;
create policy demand_voice_summary_planner on public.demand_voice_summary for all to authenticated using (ot_is_planner()) with check (ot_is_planner());
grant select, insert, update, delete on public.demand_voice_raw, public.demand_voice_summary to authenticated, service_role;
grant usage, select on sequence public.demand_voice_raw_id_seq to service_role;
select cron.unschedule(jobid) from cron.job where jobname = 'demand-voice-raw-cleanup';
select cron.schedule('demand-voice-raw-cleanup', '0 18 * * 0', $$ delete from public.demand_voice_raw where collected_at < now() - interval '28 days' $$);
