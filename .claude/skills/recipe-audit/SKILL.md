---
name: recipe-audit
description: 로운 원가 시즌 레시피 등록/정교화 후 반드시 돌리는 양방향 전수 대조. 사용자가 "레시피 전수 대조", "매칭 확인", "레시피 검증", "시즌 정교화", "매칭 안 된 자재", "레시피 새로 등록했어" 등을 언급하거나 recipe_items에 시즌 레시피를 넣고/고친 직후에는 반드시 이 스킬을 사용한다. Supabase MCP(execute_sql)로 ①레시피→구매 ②구매→레시피 양방향을 한 번에 진단하고 수정 후 스냅샷을 비운다.
---

# 레시피 양방향 전수 대조 (recipe-audit)

시즌 레시피를 넣거나 고친 뒤 원가율이 맞게 나오려면 **두 방향을 모두** 대조해야 한다.
2026-09-09 초여름 정교화에서 확립 — 한 방향만 보면 실사용액 수 %p가 조용히 누락된다.

- **A. 레시피→구매**: 레시피에 적힌 자재가 실구매와 연결되는가 (수기명칭·죽은 코드 → 메뉴 단가 null)
- **B. 구매→레시피**: 실구매된 자재가 어느 레시피에든 붙는가 (미커버 → 그 사용액이 원가율에서 통째로 빠짐)

## 준비값

```sql
select id, name, start_month, end_month from seasons order by created_at;
```
대상 시즌의 `:SID`(id), `:S`(start_month), `:E`(end_month 다음날 = end_month + 1일)를 정한다.
project_id는 mnqgqgwdoztdbdyhjqyo.

## 반드시 지킬 것 (실수 이력)

1. **별칭 커버리지는 재귀(union-find 동등)로만 판정** — material_aliases는 양방향·다단 사슬(직송↔TC↔팜푸). alt→primary 단일홉 조인은 연결된 자재를 미매칭으로 과대집계한다(실측: 4.5%p로 오판 → 실제 1.2%p). status='confirmed'만 유효하고, 같은 쌍이 방향 바꿔 중복 존재할 수 있다.
2. **코드는 이름만 보고 믿지 말 것** — 엑셀표상 "건고추"였던 10020042가 구매 데이터에선 강동깍두기였던 실사례. 교체·별칭 전에 반드시 material_usage의 실제 자재명으로 검증.
3. **수기명칭이라고 다 문제는 아님** — 사입(매장 직접구매) 자재는 정당하게 수기다. 현재 사입 예외: app.js `GROUNDED_RATIO_EXEMPT_CODES`(산초기름·대추). 새 사입 확정 시 이 목록에 추가.
4. **주재료인데 usage_amount가 null/0인 행**은 레시피 전개에서 통째로 빠진다 (실사례: 치킨팝콘·배추김치). 단, 장식용 의도적 0(레몬·데코화이트)도 있으니 주재료만 걸러 사용자 확인.
5. **수정 후에는 그 시즌 pivot_snapshot 삭제** — 종료 시즌은 영구 캐시라 안 지우면 옛 계산이 계속 보인다: `delete from pivot_snapshot where season_id = :SID;` (다음 피벗 로드 때 5~6분 재계산됨을 사용자에게 안내)
6. 결과 보고 순서: 수기/죽은코드 표(제안 코드+근거) → 사입/확인 필요 → 미커버 자재 표(사용액·원가율%p 내림차순, 합계 %p) → 실행 여부 질문. **사용자 승인(plan-before-execute) 후 교체 실행.**

## A-1. 수기명칭·이상 코드 (레시피 쪽)

```sql
select r.menu_name, r.material_code, r.material_name, r.conversion_factor, r.input_weight, r.usage_amount, r.material_price
from recipe_items r where r.season_id = :SID
  and r.material_code not like '#%' and r.material_code not in ('음용수','정제수')
  and r.material_code !~ '^[0-9]+$'
order by r.menu_name, r.id;
```

## A-2. 가격 근거 없는 정식 코드 (전 기간 구매 이력·별칭 연결 모두 없음)

```sql
with recursive edges as (
  select primary_material_code x, alt_material_code y from material_aliases where status='confirmed'
  union select alt_material_code, primary_material_code from material_aliases where status='confirmed'
),
reach_u as (
  select distinct material_code x from material_usage
  union select e.y from reach_u r join edges e on e.x = r.x
)
select r.material_code, min(r.material_name) mname, string_agg(distinct r.menu_name, ', ') menus
from recipe_items r where r.season_id = :SID and r.material_code ~ '^[0-9]+$'
  and r.material_code not in (select x from reach_u)
group by 1 order by 1;
```

## A-3. 주재료 사용량 누락 / 완성중량 누락

```sql
select menu_name, material_code, material_name, cooked_weight, input_weight, usage_amount
from recipe_items where season_id = :SID
  and ((usage_amount is null or usage_amount = 0) and material_code not in ('음용수','정제수')
       or cooked_weight is null or cooked_weight = 0)
order by menu_name;
```

## B. 실사용됐는데 레시피가 못 받는 자재 (미커버 — 핵심)

```sql
with recursive edges as (
  select primary_material_code x, alt_material_code y from material_aliases where status='confirmed'
  union select alt_material_code, primary_material_code from material_aliases where status='confirmed'
),
reach as (
  select distinct material_code x from recipe_items where season_id = :SID
  union select e.y from reach r join edges e on e.x = r.x
),
sales as (select sum(sales_total)/1.1 net from store_sales where sales_date >= ':S' and sales_date < ':E'),
su as (
  select material_code, max(material_name) mname, max(remark) remark, sum(actual_usage_amount)::bigint amt
  from material_usage where period_end >= ':S' and period_end < ':E'
  group by 1 having sum(actual_usage_amount) > 0
)
select su.material_code, su.mname, su.remark, su.amt,
  round((su.amt / (select net from sales) * 100)::numeric, 2) cost_pct
from su where su.material_code not in (select x from reach)
order by su.amt desc limit 30;
-- 합계도 같이: count(*), sum(amt), sum/net*100
```

## 수정 패턴 (승인 후)

- **코드 교체**: `update recipe_items set material_code=?, material_name=?, conversion_factor=? where season_id=:SID and material_code=?` — 대체 후보는 material_usage에서 `mname ilike '%키워드%'` + 최근 구매일로 찾고, 여러 시즌 공통이면 시즌별 각각.
- **별칭 확정**: 같은 자재의 공급처 변형이면 material_aliases에 (primary=레시피 코드, alt=구매 코드, status='confirmed') — 양방향 중복 존재 가드(NOT EXISTS) 필수.
- **메뉴 누락**: 인접 시즌(여름 기준본) 동일 메뉴가 있으면 그 구성 복사, 없으면 단일 자재 1000/1000/1000(단일 자재 메뉴는 비율만 맞으면 g당원가 정확) 후 사용자에게 구성 보강 요청.
- 미커버 잔여 0.5~1%p 수준이면 정상 범위(소액 자재 다수) — 사용자에게 잔여 목록만 보고.

## 마무리

1. `delete from pivot_snapshot where season_id = :SID;`
2. 사용자에게: 새로고침 → 피벗 재계산 확인 → 화면 "인당소비량 자동계산" 재실행 안내(menu_consumption 갱신).
3. 처리 전/후 미커버 %p를 함께 보고.
