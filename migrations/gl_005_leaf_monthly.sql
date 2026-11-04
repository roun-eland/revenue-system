-- 한 계정(말단)의 매장×월 금액만 가볍게 읽는 함수 — 예상실적의 수도광열비 계절 비율(전년 같은 달 ÷ 전년 직전 3개월)용
-- gl_monthly_stores 와 같은 집계(매장 전표·부호 반영)이고, 계정을 하나로 좁혀 행 수가 적다 (1000행 한도 안)
create or replace function public.gl_leaf_monthly(p_from text, p_leaf text)
returns table(ym text, store_code text, amount numeric)
language sql stable
set search_path to 'public'
as $$
  select v.ym, v.store_code, sum(v.amount * coalesce(m.sign, 1))::numeric
  from gl_voucher v
  left join gl_acct_map m on m.acct_code = v.acct_code and m.func = v.func
  where v.part = 'store' and v.ym >= p_from and coalesce(m.leaf_code, 'UNMAPPED') = p_leaf
  group by v.ym, v.store_code
  order by 1, 2
$$;
grant execute on function public.gl_leaf_monthly(text, text) to authenticated;
