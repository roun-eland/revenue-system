-- 수요 모니터링 4단계: 월간 리포트(초안→검토·수정→승인 후 게시)
-- 이미 Supabase에 적용됨(2026-10-22). 다시 실행해도 안전하도록 idempotent.
create table if not exists public.demand_reports (
  ym text primary key,                         -- 'YYYY-MM' (리포트 대상 월)
  status text not null default 'draft' check (status in ('draft','approved')),
  title text,
  data jsonb,                                  -- 숫자 스냅샷(검색·고객 반응·점포·한계)
  highlights jsonb,                            -- 규칙 기반 자동 요점(문장 배열)
  narrative jsonb,                             -- AI 해설 {headline, summary[], insights{}, risks[], actions[]}; 사람이 수정 가능
  model text,
  generated_at timestamptz default now(),
  edited_at timestamptz,
  approved_at timestamptz,
  approved_by text
);

alter table public.demand_reports enable row level security;
drop policy if exists demand_reports_planner on public.demand_reports;
create policy demand_reports_planner on public.demand_reports for all to authenticated
  using (public.ot_is_planner()) with check (public.ot_is_planner());

grant select, insert, update, delete on public.demand_reports to authenticated;
grant all on public.demand_reports to service_role;
