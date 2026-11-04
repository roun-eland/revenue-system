// 예상실적 — 제조경비·판관비·안분비 추정 규칙 (2026-11-03, 전표 21개월 분석 + 사용자 확정)
// 입력: gl_voucher(전표) 집계 · store_sales · store_info(임차료율·계약구분·면적) · pnl_fixed_cost(기타제조경비 기준표)
// 규칙 (직전 3개월 = 전표가 있는 가장 최근 3개월):
//   복리후생(제조)·세금과공과(제조)   매장별 (직전 3개월 계정합 ÷ 직전 3개월 급여합) × 예상 급여(직원+아르바이트)
//   소모품비                           매장별 '소모품비_매장집기' 최근 6개월 평균 금액 (타계정대체_FI 등 그 외 소모품은 견본비(부자재)로 대체되어 0) — 월별 특이비용은 화면에서 입력
//   광고선전비                         매장마다 5만원 고정 (사용자 지정 2026-11-04, 추가 광고는 특이비용으로 입력)
//   견본비                             ① 견본비(부자재) = pnl.js 에서 부자재 사용액 ÷ 실매출 비율 × 예상 순매출 / ② 견본비(사입) = 매장별 '견본비_원부재료_국내' 최근 6개월 평균 금액 / 성과상여 등 0
//   수도광열비                         직전 3개월 합계 평균 (분해·기온 보정은 백테스트에서 개선이 없어 쓰지 않음 · 이력 없는 신규점은 면적 × 단위면적당 평균)
//   운반비                             직전 3개월 평균 (운반비 ÷ 순매출) × 예상 순매출
//   감가상각비·기타 고정 계정          직전 3개월 평균 금액 × 영업일 비율
//   기타제조경비(⑩)                   사용자 기준표(통신비·소각·청소·방역·리스·대행·유지보수) 합계 — 표에 없는 매장은 항목별 중앙값 (사용자가 관리하던 구분이 ⑩ — 브랜드 실적표·전표 이력은 이 항목들이 ⑨ 지급수수료)
//   지급임차료(판관, ⑫)                임대을: 임차료율 × 순매출 / 임대갑: 직전 3개월 평균 고정액 (IFRS16 조정과 상쇄)
//   안분비                             법인 안분(EP 배부) = 직전 3개월 평균 고정 금액 / 브랜드 안분 = 가장 최근 달 고정 금액
// 급여_직원·퇴직급여·식재료원가·의제매입·급여_아르바이트는 pnl.js 의 기존 방식(맨파워·원가율·누적+잔여)을 그대로 쓴다.

const EST_SKIP = new Set(['food_gross', 'food_tax', 'skip72', 'UNMAPPED', 'int_inc', 'fin_cost', 'oth_gain', 'oth_loss', 'food', 'pay_ft', 'pay_pt', 'retire']);
const EST_ALLOC_SKIP = new Set(['food_gross', 'food_tax', 'skip72', 'UNMAPPED', 'int_inc', 'fin_cost', 'oth_gain', 'oth_loss', 'food']);
const EST_ZERO = new Set(['cogs.4.4.1', 'cogs.4.3.2', 'cogs.4.10', 'cogs.3.3', 'sga.2', 'sga.8', 'cogs.5', 'cogs.6']);   // 매장 추정에서 규칙 계산을 하지 않는 계정 (안분 계산에서도 제외) — 광고(sga.8)·기타제조경비(⑩)는 아래에서 따로 넣는다
const EST_ALLOC_ZERO = new Set([...EST_ZERO, 'cogs.4.4.2']);   // 안분 계산에서 빼는 계정 (견본비는 매장별로만 추정)
const EST_AVG6 = new Set(['cogs.4.3.1', 'cogs.4.4.2']);       // 들쭉날쭉한 계정 — 매장별 최근 6개월 평균 금액 (소모품비_매장집기, 견본비_사입)
const EST_AD = 50000;   // 광고선전비 — 매장마다 월 5만원
const EST_PAYLINK = new Set(['cogs.4.1', 'cogs.4.8']);
const EST_FIX_ITEMS = ['통신비', '소각', '청소', '방역', '리스', '대행', '유지보수'];
// 로운샤브 프리미엄 매장 — 이력이 없는 신규점(동부산·수지)의 대체값은 전체 평균이 아니라 이 매장들의 평균을 쓴다 (사용자 지시 2026-11-03)
const EST_PREMIUM = new Set(['RU042', 'RU043', 'RU044', 'RU045', 'RU046', 'RU047']);
const estMean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const estMedian = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function loadEst(ym) {
  const from = shiftYm(ym, -7);   // 최근 6개월 평균 계정까지 쓰려면 7개월 전부터
  const [gs, ss, corp, brand, fx, si] = await Promise.all([
    pageAll((a, b) => sb.rpc('gl_monthly_stores', { p_from: from }).order('ym').order('store_code').order('leaf').range(a, b)).then(data => ({ data })),   // 1814행 > 1000 → 나눠 읽는다
    sb.rpc('store_sales_all', { p_from: from }),
    pageAll((a, b) => sb.rpc('gl_monthly', { p_scope: 'corp', p_store: null }).order('ym').order('leaf').range(a, b)).then(data => ({ data })),
    pageAll((a, b) => sb.rpc('gl_monthly', { p_scope: 'brand', p_store: null }).order('ym').order('leaf').range(a, b)).then(data => ({ data })),
    sb.from('pnl_fixed_cost').select('store_code,item,amount').limit(2000),
    sb.from('store_info').select('store_code,rent_rate,contract_type,area_m2').limit(200)
  ]);
  for (const r of [gs, ss, corp, brand, fx, si]) if (r.error) throw r.error;
  const amt = {};                               // 매장 → 계정(말단) → 월 → 금액
  for (const r of gs.data || []) { const a = amt[r.store_code] = amt[r.store_code] || {}; (a[r.leaf] = a[r.leaf] || {})[r.ym] = +r.amount; }
  const months = [...new Set((gs.data || []).map(r => r.ym))].filter(m => m < ym).sort();
  const base = months.slice(-3), base6 = months.slice(-6);
  if (!base.length) return null;                // 전표가 아직 없으면 규칙을 적용하지 않는다
  const sales = {};                             // 매장 → 월 → 순매출
  for (const r of ss.data || []) (sales[r.store_code] = sales[r.store_code] || {})[r.ym] = (+r.gross || 0) / 1.1;
  const info = {}; for (const r of si.data || []) info[r.store_code] = { rate: r.rent_rate == null ? null : +r.rent_rate, contract: r.contract_type, area: +r.area_m2 || 0 };
  const fixed = {}, perItem = {};
  for (const r of fx.data || []) { (fixed[r.store_code] = fixed[r.store_code] || {})[r.item] = +r.amount; (perItem[r.item] = perItem[r.item] || []).push(+r.amount); }
  const fixedMed = {}, fixedMedP = {};
  for (const it of EST_FIX_ITEMS) {
    fixedMed[it] = estMedian(perItem[it] || []);
    const pv = Object.keys(fixed).filter(sc => EST_PREMIUM.has(sc)).map(sc => fixed[sc][it] || 0);
    fixedMedP[it] = pv.length ? estMedian(pv) : fixedMed[it];
  }
  // 안분: 법인 = 직전 3개월 평균, 브랜드 = 가장 최근 달
  const cm = {}, bm = {};                       // 계정 → 월 → 금액
  for (const r of corp.data || []) (cm[r.leaf] = cm[r.leaf] || {})[r.ym] = +r.amount;
  for (const r of brand.data || []) (bm[r.leaf] = bm[r.leaf] || {})[r.ym] = +r.amount;
  const brandYm = [...new Set((brand.data || []).map(r => r.ym))].filter(m => m < ym).sort().pop() || base[base.length - 1];
  const corpAvg = {}, brandLast = {};
  for (const [lf, mm] of Object.entries(cm)) if (!EST_ALLOC_SKIP.has(lf) && !EST_ALLOC_ZERO.has(lf) && PNL_BY[lf]) corpAvg[lf] = base.reduce((t, m) => t + (mm[m] || 0), 0) / base.length;
  for (const [lf, mm] of Object.entries(bm)) if (!EST_ALLOC_SKIP.has(lf) && !EST_ALLOC_ZERO.has(lf) && PNL_BY[lf]) brandLast[lf] = mm[brandYm] || 0;
  const E = { base, base6, amt, sales, info, fixed, fixedMed, fixedMedP, corpAvg, brandLast, brandYm, lastYm: months[months.length - 1], pool: {}, poolP: {}, pool6: {}, poolP6: {}, fb: new Map() };
  // 이력 있는 매장들의 합산 통계 (신규점·이력 없는 매장의 대체값) — 전체 매장용(pool)과 프리미엄 매장용(poolP)
  const leaves = new Set(); for (const a of Object.values(amt)) for (const lf of Object.keys(a)) leaves.add(lf);
  const buildPool = (pick, mons) => {
    const out = {};
    for (const lf of leaves) {
      let sumA = 0, n = 0, sumS = 0, sumP = 0, sumAP = 0, area = 0;
      for (const [sc, a] of Object.entries(amt)) {
        if (!pick(sc)) continue;
        for (const m of mons) {
          const s = (sales[sc] || {})[m] || 0; if (s <= 0) continue;
          const v = (a[lf] || {})[m] || 0, p = ((a['pay_ft'] || {})[m] || 0) + ((a['pay_pt'] || {})[m] || 0);
          sumA += v; n++; sumS += s; if (p > 0) { sumP += p; sumAP += v; }
          if (lf === 'cogs.4.5' && info[sc]) area += info[sc].area || 0;
        }
      }
      out[lf] = { avg: n ? sumA / n : 0, ratio: sumS ? sumA / sumS : 0, payRatio: sumP ? sumAP / sumP : 0, perM2: area ? sumA / area : 0 };
    }
    return out;
  };
  E.pool = buildPool(() => true, base);
  E.poolP = buildPool(sc => EST_PREMIUM.has(sc), base);
  E.pool6 = buildPool(() => true, base6);
  E.poolP6 = buildPool(sc => EST_PREMIUM.has(sc), base6);
  return E;
}

// 한 매장의 추정 말단 값. c = { net: 예상 순매출, cf: 영업일 비율, pay: 예상 급여(직원+아르바이트) }
function estStore(code, c) {
  const E = S.D && S.D.est; if (!E) return { leaf: {}, pool: false };
  const A = E.amt[code] || {}, sal = E.sales[code] || {}, inf = E.info[code] || {};
  const hist = E.base.filter(m => (sal[m] || 0) > 0);
  const own = hist.length > 0, prem = EST_PREMIUM.has(code) && Object.keys(E.poolP).length > 0;
  const P = lf => (prem && E.poolP[lf]) || E.pool[lf] || { avg: 0, ratio: 0, payRatio: 0, perM2: 0 };   // 프리미엄 매장은 프리미엄 평균
  const val = (lf, m) => (A[lf] || {})[m] || 0;
  const hist6 = E.base6.filter(m => (sal[m] || 0) > 0), own6 = hist6.length > 0;
  const avg6 = lf => own6 ? estMean(hist6.map(m => val(lf, m))) : ((prem && E.poolP6[lf]) || E.pool6[lf] || { avg: 0 }).avg;   // 매장별 최근 6개월 평균 금액 (이력 없으면 프리미엄/전체 평균)
  const avg = lf => own ? estMean(hist.map(m => val(lf, m))) : P(lf).avg;
  const ratio = lf => { if (!own) return P(lf).ratio; const s = hist.reduce((t, m) => t + sal[m], 0); return s ? hist.reduce((t, m) => t + val(lf, m), 0) / s : 0; };
  const payRatio = lf => {
    if (!own) return P(lf).payRatio;
    const pm = hist.filter(m => val('pay_ft', m) + val('pay_pt', m) > 0); if (!pm.length) return P(lf).payRatio;
    const p = pm.reduce((t, m) => t + val('pay_ft', m) + val('pay_pt', m), 0);
    return p ? pm.reduce((t, m) => t + val(lf, m), 0) / p : 0;
  };
  const lfs = new Set(Object.keys(E.pool)); for (const lf of Object.keys(A)) lfs.add(lf);
  const out = {};
  for (const lf of lfs) {
    if (EST_SKIP.has(lf) || !PNL_BY[lf] || PNL_BY[lf].children.length) continue;
    let v;
    if (EST_ZERO.has(lf)) v = 0;
    else if (lf === 'cogs.4.5') v = own ? avg(lf) * c.cf : (inf.area ? inf.area * P(lf).perM2 * c.cf : avg(lf) * c.cf);   // 수도광열비 — 이력 없는 신규점은 면적 × 단위면적당 평균
    else if (lf === 'cogs.4.9') v = 0;                                                                                     // ⑨ 지급수수료(제조) — 기준표 항목은 ⑩ 기타제조경비로 넣는다
    else if (lf === 'sga.12.1') v = inf.contract === '임대을' && inf.rate != null ? inf.rate / 100 * c.net : inf.contract === '임대갑' ? avg(lf) * c.cf : ratio(lf) * c.net;
    else if (lf === 'cogs.4.6') v = ratio(lf) * c.net;
    else if (EST_AVG6.has(lf)) v = avg6(lf) * c.cf;
    else if (EST_PAYLINK.has(lf)) v = payRatio(lf) * c.pay;
    else v = avg(lf) * c.cf;
    if (v) out[lf] = v;
  }
  { const f = E.fixed[code], med = prem ? E.fixedMedP : E.fixedMed; out['cogs.4.10'] = EST_FIX_ITEMS.reduce((t, it) => t + (f ? (f[it] || 0) : med[it]), 0) * c.cf; }   // 기타제조경비 = 기준표 합계
  if (c.cf > 0) out['sga.8'] = EST_AD;                                                                                                              // 광고선전비 5만원
  if (!E.amt[code] || !own) E.fb.set(code, prem ? '프리미엄' : '전체');
  return { leaf: out, pool: !own };
}

// 안분 합계 (매장 탭의 브랜드 판관비·법인 판관비 줄 — 매장 순매출 비율로 나눈다)
function estAllocTotals() {
  const E = S.D && S.D.est; if (!E) return null;
  const sum = o => Object.values(o).reduce((t, v) => t + v, 0);
  return { corp: sum(E.corpAvg), brand: sum(E.brandLast) + snrHqTotal() };   // 브랜드 안분 = 전표 브랜드 안분 + 선임점장 급여 50%
}

// 안분비 말단 값 = 법인 안분(직전 3개월 평균) + 브랜드 안분(최근 달)
function estAllocLeaves() {
  const E = S.D && S.D.est;
  const out = {};
  if (E) {
    for (const [lf, v] of Object.entries(E.corpAvg)) out[lf] = (out[lf] || 0) + v;
    for (const [lf, v] of Object.entries(E.brandLast)) out[lf] = (out[lf] || 0) + v;
  }
  const snr = snrHqTotal(); if (snr) out[PNL_ID.pay_ft] = (out[PNL_ID.pay_ft] || 0) + snr;   // 선임점장 급여 50% → 브랜드 안분 · 급여_직원
  return out;
}
