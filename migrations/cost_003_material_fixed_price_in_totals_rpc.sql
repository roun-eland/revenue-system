-- material_fixed_price가 있는 자재·월은 g당원가 집계(RPC)에서 그램을 "금액÷고정단가"로 역산해서 쓴다.
-- (박스규격 명목수량 대신 진짜 소비 무게 — cost_002_material_fixed_price.sql 배경 설명 참고)
-- 적용 범위는 g당원가(가격) 집계뿐 — 이 두 RPC는 buildMaterialPriceResolver(By Store)에서만 쓰인다.

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
  LEFT JOIN material_fixed_price fp
    ON fp.material_code = u.material_code AND fp.usage_month = u.usage_month
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
  LEFT JOIN material_fixed_price fp
    ON fp.material_code = u.material_code AND fp.usage_month = u.usage_month
  WHERE u.period_end >= p_start
    AND u.period_end < p_end
    AND u.material_code IS NOT NULL
    AND u.store_code IS NOT NULL
  GROUP BY u.store_code, u.material_code
$function$;
