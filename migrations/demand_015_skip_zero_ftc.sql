-- 공정위 점포 수: 정보공개서를 아직 갱신하지 않은 연도는 API가 0으로 내려오므로 이전 연도에 값이 있던 브랜드의 0 행은 저장하지 않는다. 이미 적용됨(2026-10-22).
create or replace function public.demand_skip_zero_ftc() returns trigger language plpgsql as $$
begin
  if new.source = 'ftc' and coalesce(new.total, 0) = 0 and exists (
    select 1 from public.demand_store_counts o where o.brand_id = new.brand_id and o.source = 'ftc' and o.area = new.area and o.period < new.period and o.total > 0)
  then return null; end if;
  return new;
end $$;
drop trigger if exists demand_skip_zero_ftc on public.demand_store_counts;
create trigger demand_skip_zero_ftc before insert or update on public.demand_store_counts for each row execute function public.demand_skip_zero_ftc();
-- 월 1회(매월 1일 13:00 KST) 올해·작년 기준년도 점포 수 갱신 (pg_cron demand-ftc-monthly)
