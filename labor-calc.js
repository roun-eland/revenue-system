// 로운 생산성 — 월 누적 인건비 공통 계산 (생산성 전사 대시보드(ot.js)와 홈 점수판(home.js)이 같이 쓴다. 숫자가 화면마다 달라지지 않게 한곳에 둔다.)
// 인건비 = 메이트 급여(급여대장 실제값, 없거나 못 믿을 구간은 근무시간×실질시급 추정)
//        + 정직원 급여(맨파워 직급 구성 × 직급 단가 + 직책수당) × 경과일 비율
//        + 연차수당(정직원 1인당 10만원/월) × 경과일 비율 + 퇴직급여(정직원 1인당 30만원/월) × 경과일 비율
// 전사 합계에는 본부 인건비 안분액(월 6,500만원 × 경과일 비율)을 더한다. 4대보험 회사부담분은 포함하지 않는다.

const LC = {
  LEAVE_PER_FT: 100000,      // 연차수당 — 정직원 1인당 월
  RETIRE_PER_FT: 300000,     // 퇴직급여 — 정직원 1인당 월 (2026-10-19 사용자 지정, 기존 순매출 0.6% 대체)
  HQ_MONTHLY: 65000000,      // 본부 인건비 안분(본부 스태프·퇴직충당금 등) 월 합계 (2026-10-19 사용자 지정)
  PAY_RATIO_MIN: 0.8,        // 급여대장 시간 ÷ 출퇴근 기록 시간이 이 범위를 벗어나면 그 구간 급여대장은 못 믿고 추정으로 대체
  PAY_RATIO_MAX: 1.2
};

// 한 매장의 월 누적 인건비.
//  dayRows : 이 매장의 집계 대상 영업일 [{iso, mate_mh}] (매출·근태가 모두 있는 날)
//  attByDate : 이 매장의 근태 일자별 {iso: mate_mh} (급여대장 시간 검증용, 휴점일 포함 전체)
//  periods : 이 매장의 급여대장 구간 [{period_start, period_end, mate_pay, mate_mh}] (해당 월에 걸친 것)
//  asOfDay : 마지막 집계일의 일(day) — 정직원 항목 경과일 안분 기준
function lcStoreCost({ dim, asOfIso, eff, staff, dayRows, attByDate, periods }) {
  const asOfDay = +asOfIso.slice(8);
  const frac = asOfDay / dim;
  let payActual = 0;
  const covered = new Set(), bad = [];
  for (const p of periods || []) {
    if (p.period_end > asOfIso) continue;                  // 아직 집계일을 넘는 구간은 쓰지 않음
    let att = 0;
    for (let d = p.period_start; d <= p.period_end; d = lcAddDay(d, 1)) att += +(attByDate[d] || 0);
    const r = att > 0 ? (+p.mate_mh || 0) / att : null;
    if (r == null || r < LC.PAY_RATIO_MIN || r > LC.PAY_RATIO_MAX) { bad.push(p.period_start + '~' + p.period_end); continue; }
    payActual += +p.mate_pay || 0;
    for (let d = p.period_start; d <= p.period_end; d = lcAddDay(d, 1)) covered.add(d);
  }
  let est = 0, estDays = 0, actDays = 0;
  for (const x of dayRows) {
    if (covered.has(x.iso)) { actDays++; continue; }
    est += (+x.mate_mh || 0) * eff; estDays++;
  }
  const fixed = (staff.fullpay + staff.nfull * LC.LEAVE_PER_FT + staff.nfull * LC.RETIRE_PER_FT) * frac;
  return { mate: payActual + est, payActual, est, actDays, estDays, bad, fixed, labor: payActual + est + fixed, frac };
}
function lcAddDay(s, n) {
  const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 전사 합계에 더하는 본부 인건비 안분액 (집계 마지막 날 기준 경과일 비율)
const lcHqCost = (dim, asOfIso) => LC.HQ_MONTHLY * (+asOfIso.slice(8) / dim);
