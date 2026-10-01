-- 축산 고정단가를 월별이 아니라 자재코드 1건당 1개로 단순화.
-- 배경(사용자 확인 2026-10-01): 실제로는 "같은 코드인데 달마다 단가가 바뀌는" 게 아니라, 단가가 바뀌면
-- 공급처가 그 변경 건을 아예 새 자재코드로 발급한다 — 그래서 월 차원은 필요 없고, 코드별 현재 실단가 1개만
-- 유지하면 된다. cost_002/cost_003이 만든 "월×자재" 구조를 "자재 1개" 구조로 바꾼다.

alter table material_fixed_price drop constraint if exists material_fixed_price_usage_month_material_code_key;
alter table material_fixed_price drop column if exists usage_month;
alter table material_fixed_price add constraint material_fixed_price_material_code_key unique (material_code);

-- RPC 두 개도 월 매칭 없이 자재코드만으로 조인하도록 수정.
CREATE OR REPLACE FUNCTION public.material_usage_totals_for_range(p_start date, p_end date)
 RETURNS TABLE(material_code text, total_grams numeric, total_amount numeric)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT u.material_code,
         SUM(
           CASE WHEN fp.price_per_kg > 0 AND u.actual_usage_amount IS NOT NULL
             THEN u.actual_usage_amount / fp.price_per_kg * 1000
             ELSE u.actual_usage_qty * u.conversion_factor
           END
         ) AS total_grams,
         SUM(u.actual_usage_amount) AS total_amount
  FROM material_usage u
  LEFT JOIN material_fixed_price fp ON fp.material_code = u.material_code
  WHERE u.period_end >= p_start AND u.period_end < p_end
    AND u.material_code IS NOT NULL AND u.actual_usage_qty IS NOT NULL
  GROUP BY u.material_code;
$function$;

CREATE OR REPLACE FUNCTION public.material_usage_totals_for_range_by_store(p_start date, p_end date)
 RETURNS TABLE(store_code text, store_name text, material_code text, total_grams numeric, total_amount numeric)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    u.store_code,
    max(u.store_name) AS store_name,
    u.material_code,
    sum(
      CASE WHEN fp.price_per_kg > 0 AND u.actual_usage_amount IS NOT NULL
        THEN u.actual_usage_amount / fp.price_per_kg * 1000
        ELSE coalesce(u.actual_usage_qty, 0) * coalesce(u.conversion_factor, 0)
      END
    ) AS total_grams,
    sum(coalesce(u.actual_usage_amount, 0)) AS total_amount
  FROM material_usage u
  LEFT JOIN material_fixed_price fp ON fp.material_code = u.material_code
  WHERE u.period_end >= p_start
    AND u.period_end < p_end
    AND u.material_code IS NOT NULL
    AND u.store_code IS NOT NULL
  GROUP BY u.store_code, u.material_code
$function$;
