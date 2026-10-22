-- 브랜드·월별 수집 건수 보관 (적용 완료본과 동일). 원문은 28일 뒤 삭제되므로 건수는 따로 남긴다.
-- 주의: 네이버 블로그 검색은 날짜순으로 브랜드 글만 골라 셀 수 없어 이 값은 '수집한 표본 수'이며 실제 발행량이 아니다.
create table if not exists public.demand_voice_volume (
  brand_id bigint not null references public.demand_brands(id) on delete cascade,
  ym text not null, total integer not null default 0, sources jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(), complete boolean not null default true,
  primary key (brand_id, ym)
);
alter table public.demand_voice_volume enable row level security;
drop policy if exists demand_voice_volume_planner on public.demand_voice_volume;
create policy demand_voice_volume_planner on public.demand_voice_volume for all to authenticated using (ot_is_planner()) with check (ot_is_planner());
grant select, insert, update, delete on public.demand_voice_volume to authenticated, service_role;
create or replace function public.demand_voice_volume_refresh() returns void language sql security definer set search_path = public as $$
  insert into demand_voice_volume (brand_id, ym, total, sources, updated_at)
  select brand_id, ym, sum(n)::int, jsonb_object_agg(source, n), now()
  from (select brand_id, ym, source, count(*) n from demand_voice_raw where source in ('blog','news','youtube_video') group by 1,2,3) t group by brand_id, ym
  on conflict (brand_id, ym) do update set total = greatest(demand_voice_volume.total, excluded.total),
    sources = case when excluded.total >= demand_voice_volume.total then excluded.sources else demand_voice_volume.sources end, updated_at = now();
$$;
revoke all on function public.demand_voice_volume_refresh() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'demand-voice-raw-cleanup';
select cron.schedule('demand-voice-raw-cleanup', '0 18 * * 0', $$ select public.demand_voice_volume_refresh(); delete from public.demand_voice_raw where collected_at < now() - interval '28 days'; $$);
-- 호출 도우미(내부용): Edge Function을 예약 비밀값으로 호출. anon 키는 공개용 키.
-- create function public.demand_invoke(fn text, payload jsonb) ... (적용 완료본은 DB에 있음)
