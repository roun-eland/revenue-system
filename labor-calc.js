// 로운 생산성 — 월 누적 인건비 공통 계산 (생산성 전사 대시보드(ot.js)와 홈 점수판(home.js)이 같이 쓴다. 숫자가 화면마다 달라지지 않게 한곳에 둔다.)
//
// 누적 인건비율은 "메이트 급여가 등록된 날짜까지"만 본다 — 급여대장이 10일까지 등록돼 있으면 매출·인건비 모두 10일까지의 누적으로 계산.
//   인건비 = 메이트 급여(급여대장 실제값) + 정직원 급여(맨파워 직급 구성 × 직급 단가 + 직책수당) + 연차수당 + 퇴직급여
//   정직원 급여·연차·퇴직급여는 월 금액을 (기준일의 일 ÷ 그 달 일수)로 환산해 추정한다. 예) 10/10까지면 ÷31 × 10
//   전사 합계에는 본부 인건비 안분액(월 6,500만원)도 같은 비율로 환산해 더한다. 4대보험 회사부담분은 포함하지 않는다.
// 메이트 급여는 등록된 급여대장을 그대로 쓴다(출퇴근 기록으로 검증해 제외하지 않음 — 사용자 지시).
// 급여대장 시간이 출퇴근 기록과 많이 어긋나는 구간은 계산엔 그대로 쓰되 warn으로만 알려준다.
// 급여대장이 한 건도 없는 매장만 근무시간×실질시급 추정으로 계산하고 화면에 표시한다.

const LC = {
  LEAVE_PER_FT: 100000,      // 연차수당 — 정직원 1인당 월
  RETIRE_PER_FT: 300000,     // 퇴직급여 — 정직원 1인당 월 (2026-10-19 사용자 지정, 기존 순매출 0.6% 대체)
  HQ_MONTHLY: 65000000,      // 본부 인건비 안분(본부 스태프·퇴직충당금 등) 월 합계 (2026-10-19 사용자 지정)
  WARN_RATIO_MIN: 0.8,       // 급여대장 시간 ÷ 출퇴근 기록 시간이 이 범위를 벗어나면 "확인 필요"로만 표시(계산은 그대로)
  WARN_RATIO_MAX: 1.2
};

// 선임점장 급여 안분 (2026-10-28 사용자 지시): 맨파워에 '선임점장' 직급이 있는 매장은 그 급여(직급 단가+직책수당)의 toBrand 비율을 매장 인건비에서 빼고
// 본부(브랜드) 인건비에 더한다. 직급 단가는 기획자만 읽을 수 있어(RLS) 단가가 없는 화면(비기획자·홈)에서는 이관 없이 계산한다 — 그 화면에서도 브랜드 합계는 동일.
// 시간(생산성)은 자동으로 나누지 않는다 — 출퇴근 기록이 사람 구분 없이 합산돼 있어 기준정보 > 매장별 특이값의 보정시간으로 입력.
const LC_SENIOR = { grade: '선임점장', toBrand: 0.5 };
function lcSeniorMonthly(staff) {
  const n = staff && staff.counts ? (staff.counts[LC_SENIOR.grade] || 0) : 0;
  if (!n || typeof gradeCost === 'undefined' || !gradeCost) return 0;
  const allow = (typeof gradeAllow !== 'undefined' && gradeAllow && gradeAllow[LC_SENIOR.grade]) || 0;
  return n * ((gradeCost[LC_SENIOR.grade] || 0) + allow) * LC_SENIOR.toBrand;
}

// 한 매장의 월 누적 인건비 (급여 등록일까지).
//  dayRows : 집계 대상 영업일 [{iso, mate_mh, sales}] — 매출·근태가 모두 있는 날, 날짜 오름차순
//  attByDate : 근태 일자별 {iso: mate_mh} (급여대장 시간 검증용, 휴점일 포함 전체)
//  periods : 이 매장의 급여대장 구간 [{period_start, period_end, mate_pay, mate_mh}]
// 반환: cutIso(누적 기준일), ratioSales(그 날까지 매출), labor(그 날까지 인건비), hasPay(급여대장 실제값 사용 여부) …
function lcStoreCost({ dim, eff, staff, dayRows, attByDate, periods }) {
  const lastIso = dayRows[dayRows.length - 1].iso;
  let payActual = 0, cutIso = null;
  const covered = new Set(), bad = [];
  for (const p of periods || []) {
    if (p.period_end > lastIso) continue;                  // 매출·근태가 아직 없는 날을 포함하는 구간은 쓰지 않음
    let att = 0;
    for (let d = p.period_start; d <= p.period_end; d = lcAddDay(d, 1)) att += +(attByDate[d] || 0);
    const r = att > 0 ? (+p.mate_mh || 0) / att : null;
    if (r == null || r < LC.WARN_RATIO_MIN || r > LC.WARN_RATIO_MAX) bad.push(p.period_start + '~' + p.period_end); // 참고 표시만
    payActual += +p.mate_pay || 0;
    for (let d = p.period_start; d <= p.period_end; d = lcAddDay(d, 1)) covered.add(d);
    if (!cutIso || p.period_end > cutIso) cutIso = p.period_end;
  }
  const hasPay = !!cutIso;
  if (!hasPay) cutIso = lastIso;                            // 쓸 수 있는 급여대장이 없으면 마지막 집계일까지 추정
  let est = 0, estDays = 0, actDays = 0, ratioSales = 0;
  for (const x of dayRows) {
    if (x.iso > cutIso) break;
    ratioSales += +x.sales || 0;
    if (covered.has(x.iso)) { actDays++; continue; }
    est += (+x.mate_mh || 0) * eff; estDays++;             // 급여대장 구간 사이의 빈 날짜(또는 급여대장 없음)는 추정
  }
  const frac = +cutIso.slice(8) / dim;
  const shift = lcSeniorMonthly(staff) * frac;                // 선임점장 급여 중 본부로 이관되는 금액(이 기간)
  const fixed = (staff.fullpay + staff.nfull * LC.LEAVE_PER_FT + staff.nfull * LC.RETIRE_PER_FT) * frac - shift;
  return { mate: payActual + est, payActual, est, actDays, estDays, bad, fixed, shift, labor: payActual + est + fixed, frac, cutIso, ratioSales, hasPay };
}
function lcAddDay(s, n) {
  const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 전사 합계에 더하는 본부 인건비 안분액 (기준일의 일 ÷ 그 달 일수)
const lcHqCost = (dim, cutIso) => LC.HQ_MONTHLY * (+cutIso.slice(8) / dim);

// ---------------------------------------------------------------------------------------------
// 생산성 목표 곡선 (2026-10-28 사용자 확정, "3번 방식": 브랜드 목표 인건비 달성용 매출대별 목표선) — 설정은 여기 한 곳.
//   목표 생산성(원/MH) = max( a + b·x + c·x² , floorA + floorB·x ),  x = 그 기간 일평균 매출(총매출·VAT 포함, 백만원)
//   · 2차식: 매장 17개점의 "목표 인건비율을 맞추는 필요 생산성"을 일평균 매출에 맞춘 곡선(일매출 약 2.6~10백만에서 유효).
//   · 하한 직선: 저매출 매장(고정비 비중↑)이 인건비율 34%를 넘지 않게 두는 하한 (순천·수원이 결정; 2026-10-28 상한 35→34%).
//   · xMax: 2차식 꼭짓점(13.6) — 이보다 큰 매출은 xMax로 간주(그 위는 곡선 재산출 필요).
//   점수 = 실제 생산성 ÷ 목표 생산성 × 100. 100%를 넘어도 그대로 표시(2026-10-28 사용자: 수원 102%). 표시 상한이 필요하면 scoreCap을 숫자로(초과분은 surplus). 신호등: ≥100 정상 / ≥warn 주의 / 그 미만 위험.
//   곡선은 분기 1회 재산출하고 기간 중에는 고정한다.
const PROD_CURVE = { a: 11989, b: 14654, c: -538, floorA: 52200, floorB: 1720, xMax: 13.6, scoreCap: Infinity, warn: 90 };
function prodTargetAt(xMillion) {
  const x = Math.min(Math.max(xMillion, 0), PROD_CURVE.xMax);
  return Math.max(PROD_CURVE.a + PROD_CURVE.b * x + PROD_CURVE.c * x * x, PROD_CURVE.floorA + PROD_CURVE.floorB * x);
}
// 점수·신호등·여유
function prodScore(prod, target) {
  if (!(prod > 0) || !(target > 0)) return null;
  const raw = prod / target * 100, cap = PROD_CURVE.scoreCap;
  return { raw, shown: Math.min(raw, cap), surplus: Math.max(0, raw - cap), level: raw >= 100 ? 'g' : raw >= PROD_CURVE.warn ? 'w' : 'c' };
}
// 곡선이 요구하는 하루 총 근무시간(h)을 일매출의 직선으로 근사 — 매장 피드백의 '기준 매장표'가 요일별(평일/주말) 매출에 곡선을 그대로 쓰면
// 저매출 평일의 필요 시간이 지나치게 작아지므로(월 평균 기준 곡선) 직선 근사를 쓴다. MH(x) = mhA + mhB·x
const PROD_MH = (() => {
  const xs = [], ys = [];
  for (let x = 2.5; x <= 10.0001; x += 0.25) { xs.push(x); ys.push(x * 1e6 / prodTargetAt(x)); }
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0, sxx = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
  const b = sxy / sxx; return { a: my - b * mx, b };
})();
const prodMHAt = xMillion => PROD_MH.a + PROD_MH.b * Math.min(Math.max(xMillion, 2), 13);
