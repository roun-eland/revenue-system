-- 예상실적 조회 전용 공개 (2026-11-04): 매장 관리자(ot_profiles.role='manager')도 예상실적 화면을 볼 수 있게 한다
-- 원칙: 쓰기·삭제는 기획자 전용 그대로 / 전표 원본(gl_voucher)은 잠가 둠 / 직급 단가(ot_grades)는 기밀이라 열지 않음
--   · 읽기: 프로필이 있는 로그인 계정만 (anon 불가)
--   · 전표는 월·매장 집계 함수만 열고(개별 전표·인건비 전표 목록은 gl_detail → 기획자만)
--   · 정직원 급여는 직급 단가를 노출하지 않도록 매장별 합계만 돌려주는 함수(pnl_store_ftpay)로 계산

-- 0) 프로필이 있는 로그인 계정인지
create or replace function public.ot_has_profile() returns boolean
language sql stable security definer set search_path to 'public'
as $$ select exists (select 1 from ot_profiles p where p.user_id = auth.uid()) $$;
revoke execute on function public.ot_has_profile() from public, anon;
grant execute on function public.ot_has_profile() to authenticated;

-- 1) 읽기 정책 (쓰기는 기존 *_planner 정책 그대로)
drop policy if exists pnl_actual_read on public.pnl_actual;
create policy pnl_actual_read on public.pnl_actual for select to authenticated using (public.ot_has_profile());
drop policy if exists pnl_adjust_read on public.pnl_adjust;
create policy pnl_adjust_read on public.pnl_adjust for select to authenticated using (public.ot_has_profile());
drop policy if exists pnl_fixed_cost_read on public.pnl_fixed_cost;
create policy pnl_fixed_cost_read on public.pnl_fixed_cost for select to authenticated using (public.ot_has_profile());
drop policy if exists store_info_read on public.store_info;
create policy store_info_read on public.store_info for select to authenticated using (public.ot_has_profile());
drop policy if exists gl_acct_map_read on public.gl_acct_map;
create policy gl_acct_map_read on public.gl_acct_map for select to authenticated using (public.ot_has_profile());

-- 2) 전표 집계 함수 3개 — 호출자 권한(RLS)이 아니라 함수 권한으로 집계하되 프로필 있는 계정만 결과를 받는다
create or replace function public.gl_monthly(p_scope text, p_store text default null)
returns table(ym text, leaf text, amount numeric)
language sql stable security definer set search_path to 'public'
as $$
  select v.ym, coalesce(m.leaf_code, 'UNMAPPED') as leaf, sum(v.amount * coalesce(m.sign, 1))::numeric as amount
  from gl_voucher v
  left join gl_acct_map m on m.acct_code = v.acct_code and m.func = v.func
  where public.ot_has_profile() and case p_scope
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
create or replace function public.gl_monthly_stores(p_from text)
returns table(ym text, store_code text, leaf text, amount numeric)
language sql stable security definer set search_path to 'public'
as $$
  select v.ym, v.store_code, coalesce(m.leaf_code, 'UNMAPPED'), sum(v.amount * coalesce(m.sign, 1))::numeric
  from gl_voucher v
  left join gl_acct_map m on m.acct_code = v.acct_code and m.func = v.func
  where public.ot_has_profile() and v.part = 'store' and v.ym >= p_from
  group by v.ym, v.store_code, coalesce(m.leaf_code, 'UNMAPPED')
  order by 1, 2, 3
$$;
create or replace function public.gl_leaf_monthly(p_from text, p_leaf text)
returns table(ym text, store_code text, amount numeric)
language sql stable security definer set search_path to 'public'
as $$
  select v.ym, v.store_code, sum(v.amount * coalesce(m.sign, 1))::numeric
  from gl_voucher v
  left join gl_acct_map m on m.acct_code = v.acct_code and m.func = v.func
  where public.ot_has_profile() and v.part = 'store' and v.ym >= p_from and coalesce(m.leaf_code, 'UNMAPPED') = p_leaf
  group by v.ym, v.store_code
  order by 1, 2
$$;
revoke execute on function public.gl_monthly(text, text), public.gl_monthly_stores(text), public.gl_leaf_monthly(text, text) from public, anon;
grant execute on function public.gl_monthly(text, text), public.gl_monthly_stores(text), public.gl_leaf_monthly(text, text) to authenticated;

-- 3) 매장별 정직원 급여 합계 (맨파워 직급 구성 × 직급 단가+직책수당) — 단가는 돌려주지 않는다
--    기준 월 = p_ym 이하에서 가장 최근 맨파워 월. snr_pay = 그중 선임점장 몫(본부 50% 안분 계산용)
create or replace function public.pnl_store_ftpay(p_ym text)
returns table(r_ym text, store_code text, nfull int, fullpay numeric, snr_pay numeric)
language sql stable security definer set search_path to 'public'
as $$
  with ym as (select max(r.ym) m from ot_staff_roster r where r.ym <= p_ym)
  select (select m from ym), r.store_code, sum(r.headcount)::int,
         sum(r.headcount * (g.std_monthly_cost + coalesce(g.allowance, 0)))::numeric,
         coalesce(sum(r.headcount * (g.std_monthly_cost + coalesce(g.allowance, 0))) filter (where r.grade = '선임점장'), 0)::numeric
  from ot_staff_roster r join ot_grades g on g.grade = r.grade
  where public.ot_has_profile() and r.ym = (select m from ym)
  group by r.store_code
$$;
revoke execute on function public.pnl_store_ftpay(text) from public, anon;
grant execute on function public.pnl_store_ftpay(text) to authenticated;
