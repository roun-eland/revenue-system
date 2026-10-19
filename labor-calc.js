// 로운 생산성 — 월 누적 인건비 공통 계산 (생산성 전사 대시보드(ot.js)와 홈 점수판(home.js)이 같이 쓴다. 숫자가 화면마다 달라지지 않게 한곳에 둔다.)
//
// 누적 인건비율은 "메이트 급여가 등록된 날짜까지"만 본다 — 급여대장이 10일까지 등록돼 있으면 매출·인건비 모두 10일까지의 누적으로 계산.
//   인건비 = 메이트 급여(급여대장 실제값) + 정직원 급여(맨파워 직급 구성 × 직급 단가 + 직책수당) + 연차수당 + 퇴직급여
//   정직원 급여·연차·퇴직급여는 월 금액을 (기준일의 일 ÷ 그 달 일수)로 환산해 추정한다. 예) 10/10까지면 ÷31 × 10
//   전사 합계에는 본부 인건비 안분액(월 6,500만원)도 같은 비율로 환산해 더한다. 4대보험 회사부담분은 포함하지 않는다.
// 급여대장이 한 건도 믿을 수 없는 매장은(시간이 출퇴근 기록과 크게 어긋남) 그 매장만 근무시간×실질시급 추정으로 계산하고 화면에 표시한다.

const LC = {
  LEAVE_PER_FT: 100000,      // 연차수당 — 정직원 1인당 월
  RETIRE_PER_FT: 300000,     // 퇴직급여 — 정직원 1인당 월 (2026-10-19 사용자 지정, 기존 순매출 0.6% 대체)
  HQ_MONTHLY: 65000000,      // 본부 인건비 안분(본부 스태프·퇴직충당금 등) 월 합계 (2026-10-19 사용자 지정)
  PAY_RATIO_MIN: 0.8,        // 급여대장 시간 ÷ 출퇴근 기록 시간이 이 범위를 벗어나면 그 구간 급여대장은 못 믿고 제외
  PAY_RATIO_MAX: 1.2
};

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
    if (r == null || r < LC.PAY_RATIO_MIN || r > LC.PAY_RATIO_MAX) { bad.push(p.period_start + '~' + p.period_end); continue; }
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
  const fixed = (staff.fullpay + staff.nfull * LC.LEAVE_PER_FT + staff.nfull * LC.RETIRE_PER_FT) * frac;
  return { mate: payActual + est, payActual, est, actDays, estDays, bad, fixed, labor: payActual + est + fixed, frac, cutIso, ratioSales, hasPay };
}
function lcAddDay(s, n) {
  const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 전사 합계에 더하는 본부 인건비 안분액 (기준일의 일 ÷ 그 달 일수)
const lcHqCost = (dim, cutIso) => LC.HQ_MONTHLY * (+cutIso.slice(8) / dim);
