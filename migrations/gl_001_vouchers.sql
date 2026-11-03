-- 전표(원가요소 단위 손익 전표) 저장 — 과거 실적을 매장·브랜드·안분별로 보고 계정에서 전표까지 내려가 보기 위한 테이블 (2026-11-03)
-- 모두 기획자만 읽고 쓴다(ot_is_planner). 인건비 계열(급여·퇴직급여·상여)은 업로드 때 전표번호·텍스트를 비우고 금액만 저장한다.
--   part: store(매장 코스트센터) / corp(법인 안분 — 텍스트에 EP) / brand(브랜드 안분 — 그 밖의 비매장 코스트센터)

-- 원가요소(+기능영역) → 손익 계정(pnl-accounts.js 의 말단 코드). sign = 수익 계정(53xxx)은 −1 로 뒤집어 양수로 본다
create table if not exists public.gl_acct_map (
  acct_code   text not null,
  func        text not null,                 -- 1000 제조 / 2000 판관
  leaf_code   text not null,
  acct_name   text,
  hide_detail boolean not null default false, -- true: 전표 내역(텍스트·전표번호)을 저장·표시하지 않는다
  sign        smallint not null default 1,
  primary key (acct_code, func)
);

create table if not exists public.gl_cc_names (
  cost_center text primary key,
  name        text
);

create table if not exists public.gl_voucher (
  id          bigint generated always as identity primary key,
  ym          text not null,
  posted      date not null,
  doc_no      text,
  cost_center text not null,
  acct_code   text not null,
  func        text not null,
  amount      numeric(18,2) not null,
  text        text,
  part        text not null check (part in ('store','corp','brand')),
  store_code  text
);
create index if not exists gl_voucher_ym_part_store on public.gl_voucher (ym, part, store_code);
create index if not exists gl_voucher_acct on public.gl_voucher (acct_code, ym);

alter table public.gl_acct_map enable row level security;
alter table public.gl_cc_names enable row level security;
alter table public.gl_voucher  enable row level security;
drop policy if exists gl_acct_map_planner on public.gl_acct_map;
drop policy if exists gl_cc_names_planner on public.gl_cc_names;
drop policy if exists gl_voucher_planner  on public.gl_voucher;
create policy gl_acct_map_planner on public.gl_acct_map for all to authenticated using (public.ot_is_planner()) with check (public.ot_is_planner());
create policy gl_cc_names_planner on public.gl_cc_names for all to authenticated using (public.ot_is_planner()) with check (public.ot_is_planner());
create policy gl_voucher_planner  on public.gl_voucher  for all to authenticated using (public.ot_is_planner()) with check (public.ot_is_planner());
grant select, insert, update, delete on public.gl_acct_map, public.gl_cc_names, public.gl_voucher to authenticated;
revoke all on public.gl_acct_map, public.gl_cc_names, public.gl_voucher from anon;
revoke truncate, references, trigger on public.gl_acct_map, public.gl_cc_names, public.gl_voucher from authenticated;

-- 월 × 계정(말단) 합계. scope: all(브랜드 전체) / stores(매장 합계) / store(한 매장, p_store) / corp / brand / alloc(법인+브랜드)
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
$$;

-- 계정 → 전표 내역. 인건비 계열(hide_detail)은 돌려주지 않는다. 금액 큰 순 최대 1000건
create or replace function public.gl_detail(p_scope text, p_store text, p_ym text, p_leaves text[])
returns table (doc_no text, posted date, cost_center text, cc_name text, acct_code text, acct_name text, amount numeric, text text, part text, store_code text)
language sql stable security invoker set search_path = public as $$
  select v.doc_no, v.posted, v.cost_center, c.name, v.acct_code, m.acct_name, (v.amount * m.sign)::numeric, v.text, v.part, v.store_code
  from gl_voucher v
  join gl_acct_map m on m.acct_code = v.acct_code and m.func = v.func
  left join gl_cc_names c on c.cost_center = v.cost_center
  where v.ym = p_ym and m.leaf_code = any(p_leaves) and not m.hide_detail
    and case p_scope
          when 'all'    then true
          when 'stores' then v.part = 'store'
          when 'store'  then v.part = 'store' and v.store_code = p_store
          when 'corp'   then v.part = 'corp'
          when 'brand'  then v.part = 'brand'
          when 'alloc'  then v.part in ('corp','brand')
          else false end
  order by abs(v.amount) desc
  limit 1000
$$;

-- 매장 월 총매출(부가세 포함). p_store null 이면 전 매장 합계
create or replace function public.store_sales_monthly(p_store text default null)
returns table (ym text, gross numeric)
language sql stable security invoker set search_path = public as $$
  select to_char(sales_date, 'YYYY-MM'), sum(sales_total)::numeric
  from store_sales
  where (p_store is null or store_code = p_store)
  group by 1
$$;
grant execute on function public.gl_monthly(text, text), public.gl_detail(text, text, text, text[]), public.store_sales_monthly(text) to authenticated;
revoke execute on function public.gl_monthly(text, text), public.gl_detail(text, text, text, text[]), public.store_sales_monthly(text) from public, anon;
