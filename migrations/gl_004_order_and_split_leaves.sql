-- 2026-11-04: (1) 1000행 한도 대응 — 집계 함수에 정렬 추가(클라이언트는 range 로 나눠 읽음, pnl-gl.js pageAll)
--             (2) 소모품비(③)·견본비(④)를 둘로 나눈 계정 매핑, 이미 입력한 고정값의 계정 코드 이전
-- 배경: gl_monthly_stores 는 1814행, pnl_actual 은 1578행이라 API 한도(1000행)에 걸려 화면이 일부만 읽고 있었다
--       (평촌 감가상각 월 888만원이 9만원으로 추정되고, 수도광열비·복리후생이 낮게 나온 원인).
create or replace function public.gl_monthly_stores(p_from text)
returns table (ym text, store_code text, leaf text, amount numeric)
language sql stable security invoker set search_path = public as $$
  select v.ym, v.store_code, coalesce(m.leaf_code, 'UNMAPPED'), sum(v.amount * coalesce(m.sign, 1))::numeric
  from gl_voucher v
  left join gl_acct_map m on m.acct_code = v.acct_code and m.func = v.func
  where v.part = 'store' and v.ym >= p_from
  group by v.ym, v.store_code, coalesce(m.leaf_code, 'UNMAPPED')
  order by 1, 2, 3
$$;

create or replace function public.gl_monthly(p_scope text, p_store text default null)
returns table (ym text, leaf text, amount numeric)
language sql stable security invoker set search_path = public as $$
  select v.ym, coalesce(m.leaf_code, 'UNMAPPED') as leaf, sum(v.amount * coalesce(m.sign, 1))::numeric as amount
  from gl_voucher v
  left join gl_acct_map m on m.acct_code = v.acct_code and m.func = v.func
  where case p_scope
          when 'all'    then true
          when 'stores' then v.part = 'store'
          when 'store'  then v.part = 'store' and v.store_code = p_store
          when 'corp'   then v.part = 'corp'
          when 'brand'  then v.part = 'brand'
          when 'alloc'  then v.part in ('corp','brand')
          else false end
  group by v.ym, coalesce(m.leaf_code, 'UNMAPPED')
  order by 1, 2
$$;

update public.gl_acct_map set leaf_code = 'cogs.4.3.1' where func = '1000' and acct_code = '51290301';                                  -- 소모품비_매장집기
update public.gl_acct_map set leaf_code = 'cogs.4.3.2' where func = '1000' and acct_code like '5129%' and acct_code <> '51290301';     -- 그 외 소모품(타계정대체_FI·청소용품 등)
update public.gl_acct_map set leaf_code = 'cogs.4.4.2' where func = '1000' and acct_code = '51350101';                                  -- 견본비_원부재료_국내 = 사입
update public.gl_acct_map set leaf_code = 'cogs.4.4.1' where func = '1000' and acct_code like '5135%' and acct_code <> '51350101';     -- 그 외 견본비
update public.pnl_adjust set account_code = 'cogs.4.3.1' where account_code = 'cogs.4.3';
update public.pnl_adjust set account_code = 'cogs.4.4.2' where account_code = 'cogs.4.4';
