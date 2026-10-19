-- 본부 재고 업로드 이력(기준일별 행수·재고금액) — 화면의 기준일 선택·전주 대비에 사용. RLS로 기획자만 조회됨.
create or replace function hq_inventory_snapshots() returns table(snapshot_date date, n bigint, amount numeric)
language sql stable security invoker set search_path = public as
$$ select snapshot_date, count(*), sum(stock_amount) from hq_inventory group by snapshot_date order by snapshot_date desc $$;
grant execute on function hq_inventory_snapshots() to authenticated;
