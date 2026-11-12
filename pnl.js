// 로운 예상실적 — 브랜드·매장 예상 손익 (틀 v1, 2026-11-03)
// 매장 = 매장별 예상 손익(계정 트리 pnl-accounts.js), 브랜드 = 매장 합계 + 안분비 + 특이비용.
// 1차에 값이 채워지는 계정: 외형매출·부가세(매출예측 확정) · 식재료원가(월 누적 원가율×순매출) · 의제매입세액 · 급여_직원·급여_아르바이트·퇴직급여.
// 나머지(제조경비·판관비·안분비 등)는 데이터를 받는 대로 채운다. 특이비용은 이 화면에서 입력 → 예상실적에 바로 반영(pnl_adjust).
// ⚠ 인건비·매출 계산은 생산성 화면(labor-calc.js·ot.js)과 같은 규칙을 단순화해 복제했다 — 그쪽 규칙을 바꾸면 여기도 확인할 것.

const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const GRADE_ORDER = ['선임점장', '점장', '부점장', 'GM', '매니저', '캡틴', '헤드', 'ST', 'TM', 'HIT'];
const TRUE_NET_DED = 72000000;   // 진이익 = 당기순이익 − 72백만원 (사용자 지정 추정, 11월 기준) — 값이 바뀌면 여기만 고친다
// 금융손익 = 이자수익 1.25 − 금융비용 20.25 = −19백만원/월 (26년6~9월 4개월 평균, 월 −18~−20로 거의 고정). 영업외손익(6번)은 12개월 중앙값 0 → 0
const INT_INC_EST = 1250000, FIN_COST_EST = 20250000;
const MANUAL_NOTE = '표에서 직접 입력';   // 표 칸에서 직접 고친 특이비용은 이 메모의 한 줄로 모은다
const FOOD_TAX_PCT = 0.008;   // 의제매입세액 공제액 — 순매출의 0.8% (원본 손익표가 전 매장 -0.8%) — 가정, 값이 바뀌면 여기만 고친다
const STORES = Object.keys(OT_DATA);
const sname = c => ((OT_DATA[c] && OT_DATA[c].name) || c).replace(/\s*\(신규\)\s*/g, '');   // 화면에는 매장명만 (신규 표기 제외)

const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };
const lastDay = ym => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

const S = { sub: null, ym: null, tab: 'brand', mode: 'l1', scope: 'all', unit: 'mm', act: {}, acScope: 'sheet', gl: {}, glLeaves: new Set(), glHidden: new Set(), storeInfo: [], storeByCc: {}, pick: null, folded: new Set(), months: [], D: null, adj: [], fc: { amt: {}, plan: {} }, F: null, fb: null };

// ---------- 시작 ----------
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.replace('../'); return; }
  $('loginView').hidden = true; $('appView').hidden = false;
  $('whoEmail').textContent = session.user.email;
  let role = 'planner';
  try {
    const { data } = await sb.from('ot_profiles').select('role').eq('user_id', session.user.id).maybeSingle();
    if (data && data.role) role = data.role;
  } catch (e) { /* 무시 */ }
  $('roleChip').textContent = role === 'planner' ? '기획자' : '매장 관리자';
  S.planner = role === 'planner';
  if (!S.planner) {   // 매장 관리자: 조회 전용 — 전표 업로드·특이비용 입력·표 직접 입력·전표 내역 보기는 숨긴다 (쓰기는 DB 권한도 막음)
    document.querySelector('#plNav button[data-view="upload"]').hidden = true;
    document.querySelector('#plNav button[data-view="submit"]').hidden = true;
    $('adjCard').hidden = true;
  }
  document.querySelectorAll('#plNav button').forEach(b => { b.onclick = () => showTab(b.dataset.view); });
  document.querySelectorAll('#plMode button').forEach(b => { b.onclick = () => { S.mode = b.dataset.mode; renderAll(); }; });
  document.querySelectorAll('#plScope button').forEach(b => { b.onclick = () => { S.scope = b.dataset.scope; renderAll(); }; });
  $('plPick').onchange = () => { S.pick = $('plPick').value; renderAll(); };
  $('plMonth').onchange = () => loadMonth($('plMonth').value);
  $('acScope').onchange = () => { S.acScope = $('acScope').value; S.actScrolled = false; renderAll(); if (S.tab === 'actual') showTab('actual'); };
  $('upFile').onchange = () => glChoose($('upFile').files[0]);
  $('upSave').onclick = glSave;
  $('upRead').onclick = glPasteRead;
  $('upPaste').addEventListener('paste', () => setTimeout(glPasteRead, 50));   // 붙여넣으면 바로 읽는다 (붙여넣은 글자가 칸에 들어간 뒤)
  $('glClose').onclick = () => { $('glModal').hidden = true; };
  $('glModal').onclick = e => { if (e.target === $('glModal')) $('glModal').hidden = true; };
  $('adjAdd').onclick = addAdjust;
  $('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.replace('../'); };
  fillAdjustAccounts();
  loadGlMeta().catch(e => setMsg('전표 매핑·매장정보를 불러오지 못했습니다: ' + (e.message || e), true));
  await loadMonths();
  loadActual().then(a => { S.act = a; renderAll(); }).catch(e => setMsg('월별 실적을 불러오지 못했습니다: ' + (e.message || e), true));
  showTab(typeof navStart === 'function' ? navStart('brand') : 'brand');
}
$('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.replace('../'); };

function showTab(t) {
  S.tab = ['store', 'fcst', 'actual', 'fb', 'submit', 'upload'].includes(t) ? t : 'brand';
  if ((S.tab === 'upload' || S.tab === 'submit') && !S.planner) S.tab = 'brand';
  document.querySelectorAll('#plNav button').forEach(b => b.classList.toggle('on', b.dataset.view === S.tab));
  $('view-brand').hidden = S.tab !== 'brand';
  $('view-store').hidden = S.tab !== 'store';
  $('view-fcst').hidden = S.tab !== 'fcst';
  $('view-fb').hidden = S.tab !== 'fb';
  $('view-submit').hidden = S.tab !== 'submit';
  $('view-actual').hidden = S.tab !== 'actual';
  $('view-upload').hidden = S.tab !== 'upload';
  $('acScopeWrap').hidden = S.tab !== 'actual';
  $('plMode').hidden = S.tab === 'store' || S.tab === 'fcst' || S.tab === 'fb' || S.tab === 'upload' || S.tab === 'submit';   // 매장·매장예측 탭은 주요 계정 고정, 대신 전체 매장/매장 선택
  $('plScope').hidden = S.tab !== 'store' && S.tab !== 'fcst' && S.tab !== 'fb';
  $('plNotesCard').hidden = S.tab === 'upload' || S.tab === 'fcst' || S.tab === 'fb' || S.tab === 'submit';
  $('adjCard').hidden = S.tab === 'upload' || S.tab === 'actual' || S.tab === 'fcst' || S.tab === 'fb' || S.tab === 'submit' || !S.planner;
  renderAll();
  if (S.tab === 'actual' && !S.actScrolled && $('actualTable').querySelector('table')) { const w = $('actualTable'); w.scrollLeft = w.scrollWidth; S.actScrolled = true; }   // 처음 열면 최근 월이 보이도록 오른쪽 끝으로
}

// ---------- 데이터 ----------
async function loadMonths() {
  const { data, error } = await sb.from('sf_forecast_runs').select('ym').eq('kind', '확정').order('ym');
  if (error) { setMsg('매출예측 월을 불러오지 못했습니다: ' + error.message, true); return; }
  S.months = [...new Set((data || []).map(r => r.ym))].filter(m => m >= '2026-11');
  const sel = $('plMonth');
  sel.innerHTML = S.months.map(m => `<option value="${m}">${m.slice(0, 4)}년 ${+m.slice(5)}월</option>`).join('');
  if (!S.months.length) { setMsg('2026년 11월 이후 발행된 확정 매출예측이 없습니다.', true); return; }
  sel.value = S.months.includes('2026-11') ? '2026-11' : S.months[S.months.length - 1];
  await loadMonth(sel.value);
}

function setMsg(t, err) { const e = $('plMsg'); e.textContent = t || ''; e.style.color = err ? 'var(--crit)' : 'var(--muted)'; }

async function loadMonth(ym) {
  S.ym = ym; S.D = null;
  setMsg('불러오는 중…');
  try {
    const [D, adj, fc] = await Promise.all([loadData(ym), loadAdjust(ym), loadForecast(ym).catch(e => { console.warn('매장예측을 불러오지 못했습니다', e); return { amt: {}, plan: {} }; })]);
    S.D = D; S.adj = adj; S.fc = fc; S.fb = null;
    setMsg('');
    renderAll();
  } catch (e) { setMsg('불러오기 실패: ' + (e.message || e), true); }
}

// 브랜드 월별 실적 (pnl_actual, 원 단위) → { 'YYYY-MM': { 계정코드: 금액 } }
async function loadActual() {
  // 1578행 > API 한도 1000 → 나눠 읽는다
  const data = await pageAll((a, b) => sb.from('pnl_actual').select('ym,account_code,amount').order('ym').order('account_code').range(a, b));
  const out = {};
  for (const r of data) (out[r.ym] = out[r.ym] || {})[r.account_code] = +r.amount;
  return out;
}

async function loadAdjust(ym) {
  const { data, error } = await sb.from('pnl_adjust').select('*').eq('ym', ym).order('id');
  if (error) throw error;
  return data || [];
}

async function loadData(ym) {
  const base = shiftYm(ym, -1);   // 직전 월 = 메이트 급여율 기준
  const [runR, usageTot, grades, roster, ftpay, per, sales, perCur, salesCur, est, ftRpc] = await Promise.all([
    sb.from('sf_forecast_runs').select('ym,version,kind,daily,published_at').eq('ym', ym).eq('kind', '확정').order('version', { ascending: false }).limit(1),
    sb.rpc('material_usage_monthly_totals'),
    S.planner ? sb.from('ot_grades').select('grade,std_monthly_cost,allowance') : Promise.resolve({ data: null }),   // 직급 단가는 기획자만 — 매장 관리자는 아래 pnl_store_ftpay(매장별 합계)로 계산
    sb.from('ot_staff_roster').select('ym,store_code,grade,headcount').limit(5000),
    sb.from('ot_labor_monthly').select('store_code,ft_pay').eq('ym', ym).not('ft_pay', 'is', null),
    sb.from('ot_labor_periods').select('store_code,period_start,period_end,mate_pay').gte('period_start', base + '-01').lte('period_end', lastDay(base)).limit(2000),
    sb.from('ot_sales_daily').select('store_code,sales_date,total').gte('sales_date', base + '-01').lte('sales_date', lastDay(base)).limit(1000),
    sb.from('ot_labor_periods').select('store_code,period_start,period_end,mate_pay').gte('period_start', ym + '-01').lte('period_end', lastDay(ym)).limit(2000),   // 이번 달 급여대장(누적 메이트 급여)
    sb.from('ot_sales_daily').select('store_code,sales_date,total').gte('sales_date', ym + '-01').lte('sales_date', lastDay(ym)).limit(5000),
    loadEst(ym).catch(e => { console.warn('추정 규칙 데이터를 불러오지 못했습니다', e); return null; }),   // 전표가 없으면 null → 규칙 미적용
    S.planner ? Promise.resolve({ data: null }) : sb.rpc('pnl_store_ftpay', { p_ym: ym })
  ]);
  for (const r of [runR, usageTot, grades, roster, per, sales, perCur, salesCur, ftRpc]) if (r.error) throw r.error;
  if (!runR.data || !runR.data.length) throw new Error(`${ym} 확정 매출예측이 없습니다`);
  const run = otApplyClosures(runR.data)[0];   // 폐점·신규 오픈 보정 (화면 메모리에서만)

  // 식재료원가: 가장 최근 자재 사용 월의 매장별 누적 원가율 (홈 '누적 원가율'과 같은 식 — 자재 실사용액 ÷ 순매출)
  const months = (usageTot.data || []).map(r => (r.usage_month || '').slice(0, 7)).filter(m => m && m <= ym).sort();
  const costYm = months[months.length - 1];
  let costRate = {}, costSpan = null, brandCostRate = null;
  if (costYm) {
    const { data, error } = await sb.rpc('pnl_store_cost_rate', { p_month: costYm + '-01' });
    if (error) throw error;
    let a = 0, n = 0;
    for (const r of data || []) {
      const net = +r.net_sales || 0;
      if (net > 0) { costRate[r.store_code] = (+r.usage_amount || 0) / net; a += +r.usage_amount || 0; n += net; }
      if (r.d_from) costSpan = { from: r.d_from, to: r.d_to };
    }
    brandCostRate = n ? a / n : null;
  }

  // 견본비율: 가장 최근 부자재 사용 월의 매장별 (부자재 사용액 ÷ 그 기간 순매출) — 원가율과 같은 방식. 부자재 사용량(원가 > 데이터 > 업로드)이 없으면 규칙을 적용하지 않는다(견본비 0)
  let subRate = {}, subSpan = null, brandSubRate = null, subYm = null;
  try {
    const lm = await sb.from('material_usage_sub').select('usage_month').lte('usage_month', ym + '-01').order('usage_month', { ascending: false }).limit(1);
    if (!lm.error && lm.data && lm.data.length) {
      subYm = String(lm.data[0].usage_month).slice(0, 7);
      const { data, error } = await sb.rpc('pnl_store_sub_rate', { p_month: subYm + '-01' });
      if (error) throw error;
      let a = 0, n = 0;
      for (const r of data || []) {
        const net = +r.net_sales || 0;
        if (net > 0) { subRate[r.store_code] = (+r.usage_amount || 0) / net; a += +r.usage_amount || 0; n += net; }
        if (r.d_from) subSpan = { from: r.d_from, to: r.d_to };
      }
      brandSubRate = n ? a / n : null;
    }
  } catch (e) { console.warn('견본비율을 불러오지 못했습니다', e); subYm = null; subRate = {}; }

  // 정직원: 맨파워(가장 최근 맨파워 월, 거기에 없는 매장은 정직원 없음) × 직급 단가 — ot.js rosterFor·calcStaffPay와 같은 규칙
  const gCost = {}, gAllow = {};
  for (const g of grades.data || []) { gCost[g.grade] = g.std_monthly_cost || 0; gAllow[g.grade] = g.allowance || 0; }
  const R = {};
  for (const r of roster.data || []) { ((R[r.ym] = R[r.ym] || {})[r.store_code] = R[r.ym][r.store_code] || {})[r.grade] = r.headcount; }
  const rYm = Object.keys(R).filter(m => m <= ym).sort().pop() || null;
  const conf = {}; for (const r of ftpay.data || []) conf[r.store_code] = +r.ft_pay;
  const staff = {};
  for (const c of STORES) {
    const counts = rYm ? (R[rYm][c] || {}) : (OT_STAFF0[c] || {});
    const nfull = GRADE_ORDER.reduce((t, g) => t + (counts[g] || 0), 0);
    let fullpay = GRADE_ORDER.reduce((t, g) => t + (counts[g] || 0) * ((gCost[g] || 0) + (gAllow[g] || 0)), 0);
    if (conf[c] != null) fullpay = conf[c];     // 확정 정직원 급여(SAP)가 있으면 그 값
    let snrPay = (counts['선임점장'] || 0) * ((gCost['선임점장'] || 0) + (gAllow['선임점장'] || 0));   // 선임점장 급여(단가+직책수당) — 이 중 SNR_HQ_SHARE 는 본부 안분
    if (!S.planner) { const f = (ftRpc.data || []).find(x => x.store_code === c); fullpay = f ? +f.fullpay : 0; snrPay = f ? +f.snr_pay : 0; }   // 매장 관리자: 직급 단가 없이 서버가 돌려준 매장별 합계를 쓴다
    if (conf[c] != null) fullpay = conf[c];
    staff[c] = { nfull, fullpay, snrPay, none: !!rYm && !R[rYm][c] };
  }

  // 메이트 급여율 = 직전 월 메이트 급여(급여대장) ÷ 그 기간 순매출
  const salesBy = {}; for (const r of sales.data || []) salesBy[r.store_code] = (salesBy[r.store_code] || 0) + (+r.total || 0);
  const payBy = {}; for (const r of per.data || []) payBy[r.store_code] = (payBy[r.store_code] || 0) + (+r.mate_pay || 0);
  const mateRate = {}; let pa = 0, ps = 0;
  for (const c of Object.keys(payBy)) { const net = (salesBy[c] || 0) / 1.1; if (net > 0) { mateRate[c] = payBy[c] / net; pa += payBy[c]; ps += net; } }
  const brandMateRate = ps ? pa / ps : null;

  // 이번 달 누적: 급여대장으로 확정된 구간의 메이트 급여·같은 기간 순매출 → 남은 기간 추정에 쓴다
  const mateNow = {};
  for (const r of perCur.data || []) { const m = mateNow[r.store_code] = mateNow[r.store_code] || { mtd: 0, cover: '', salesNet: 0, days: 0 }; m.mtd += +r.mate_pay || 0; if (r.period_end > m.cover) m.cover = r.period_end; }
  for (const m of Object.values(mateNow)) m.days = +m.cover.slice(8);
  for (const r of salesCur.data || []) { const m = mateNow[r.store_code]; if (m && r.sales_date <= m.cover) m.salesNet += (+r.total || 0) / 1.1; }
  const premAvg = m => { const v = [...EST_PREMIUM].filter(c => m[c] != null).map(c => m[c]); return v.length ? v.reduce((t, x) => t + x, 0) / v.length : null; };   // 이력 있는 프리미엄 매장의 단순 평균
  return { run, ym, costYm, costRate, costSpan, brandCostRate, rYm, staff, base, mateRate, brandMateRate, premCost: premAvg(costRate), premMate: premAvg(mateRate), mateNow, est, subYm, subSpan, subRate, brandSubRate, premSub: premAvg(subRate) };
}

// 이력이 없는 매장(신규점)의 비율: 복제 원본 매장 → 없으면 브랜드 평균
function rateOf(map, code, brandAvg, premAvg) {
  if (map[code] != null) return { v: map[code], src: 'own' };
  if (typeof EST_PREMIUM !== 'undefined' && EST_PREMIUM.has(code) && premAvg != null) return { v: premAvg, src: 'premium' };   // 프리미엄 신규점은 프리미엄 매장 평균
  const cl = typeof CLONE_FROM !== 'undefined' && CLONE_FROM[code];
  if (cl && map[cl[0]] != null) return { v: map[cl[0]], src: 'clone', of: cl[0] };
  return { v: brandAvg || 0, src: 'avg' };
}

// ---------- 계산 ----------
// 선임점장 급여 본부 안분 — 매장에서 뺀 금액의 합계(폐점 달은 일할). pnl-est.js 의 안분비(브랜드 안분 · 급여_직원)에 더한다
const SNR_HQ_SHARE = 0.5;
function snrHqTotal() {
  const D = S.D; if (!D || !D.staff) return 0;
  return STORES.reduce((t, c) => t + (D.staff[c].snrPay || 0) * SNR_HQ_SHARE * ftFrac(c, D.ym), 0);
}
// 정직원 급여 일할 비율 — 폐점(OT_CLOSE_FROM)만 반영하고 신규 오픈(OT_OPEN_FROM)은 반영하지 않는다
function ftFrac(code, ym) {
  const cf = OT_CLOSE_FROM[code]; if (!cf) return 1;
  const dim = new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate(), first = ym + '-01', last = ym + '-' + String(dim).padStart(2, '0');
  return cf <= first ? 0 : cf > last ? 1 : (+cf.slice(8) - 1) / dim;
}

// 급여_아르바이트 = 급여대장 누적 메이트 급여 + 남은 기간 예상 순매출 × 반영 비율
//   반영 비율 = 누적 비율(누적 메이트 급여 ÷ 누적 순매출)과 직전 달 비율을 경과 일수/14 로 섞는다 (월 초 몇 일치만 있을 때 직전 달 비율에 가깝다)
//   이번 달 급여대장이 없는 매장은 직전 달 비율 × 예상 순매출
function matePay(code, net, mr, D) {
  const m = D.mateNow[code]; if (!m || !m.mtd) return { v: net * mr.v, how: 'prior' };
  const st = D.run.daily.stores[code]; let rem = 0;
  if (st && st.daily) for (const d of Object.keys(st.daily)) if (d > m.cover) rem += st.daily[d];
  rem /= 1.1;
  const ytd = m.salesNet > 0 ? m.mtd / m.salesNet : mr.v, w = Math.min(1, m.days / 14), rate = w * ytd + (1 - w) * mr.v;
  return { v: m.mtd + rem * rate, how: 'mtd', mtd: m.mtd, rem, rate, w };
}

// 매장별 말단 계정 값 (특이비용 제외)
function baseLeaf(code) {
  const D = S.D, st = D.run.daily.stores[code];
  const gross = st ? +st.total || 0 : 0, net = gross / 1.1;
  const cf = otCloseFrac(code, D.ym);          // 영업 일수 비율 — 아르바이트·매출 쪽(오픈 전 휴점일 제외)
  const ff = ftFrac(code, D.ym);                // 정직원 급여·퇴직급여 — 오픈 달은 한 달치(오픈 전부터 근무), 폐점 달만 일할
  const cr = rateOf(D.costRate, code, D.brandCostRate, D.premCost), mr = rateOf(D.mateRate, code, D.brandMateRate, D.premMate), sf = D.staff[code];
  const mp = matePay(code, net, mr, D);
  const leaf = {
    gross_direct: gross,
    vat: gross - net,
    food: net * cr.v,
    food_tax: -net * FOOD_TAX_PCT,
    pay_ft: (sf.fullpay - sf.snrPay * SNR_HQ_SHARE + sf.nfull * LC.LEAVE_PER_FT) * ff,   // 선임점장 급여의 50%는 매장에서 빼고 브랜드 안분비(급여_직원)로
    retire: sf.nfull * LC.RETIRE_PER_FT * ff,
    pay_pt: mp.v
  };
  const e = estStore(code, { net, cf, pay: leaf.pay_ft + leaf.pay_pt });   // 제조경비·판관비 (pnl-est.js)
  Object.assign(leaf, e.leaf);
  if (D.subYm) leaf['cogs.4.4.1'] = net * rateOf(D.subRate, code, D.brandSubRate, D.premSub).v;   // 견본비(부자재) = 부자재 사용액 ÷ 실매출 비율 × 예상 순매출 — 견본비(사입)은 pnl-est.js
  return { leaf, meta: { inRun: !!st, costSrc: cr, mateSrc: mr, mate: mp, noStaff: sf.none, closeFrac: cf, estPool: e.pool } };
}

function evalTree(leaf) {
  const memo = {};
  const get = code => {
    if (code in memo) return memo[code];
    const a = PNL_BY[code];
    let v;
    if (a.calc) v = a.calc(id => get(PNL_ID[id]));
    else if (a.children.length) v = a.children.reduce((t, c) => t + get(c), 0);
    else v = leaf[code] || 0;
    return (memo[code] = v);
  };
  PNL_ACC.forEach(a => get(a.code));
  return memo;
}

// 고정값(mode='set')이 있는 매장은 비용 계정을 모두 그 값으로 대체한다 — 입력하지 않은 계정은 0, 매출(외형·부가세)만 예측 그대로.
// 신촌 폐점 비용·수지 오픈 비용처럼 사용자가 매장 손익을 직접 추정한 경우에 쓴다
function applySets(code, leaf) {
  const sets = S.adj.filter(r => r.scope === code && r.mode === 'set' && PNL_BY[r.account_code]);
  if (!sets.length) return leaf;
  const out = { gross_direct: leaf.gross_direct, vat: leaf.vat };
  for (const r of sets) out[r.account_code] = (out[r.account_code] || 0) + (+r.amount || 0);
  return out;
}
// 계정 고정값(mode='fix') — 그 매장의 해당 계정만 입력값으로 바꾼다 (나머지 계정은 규칙 계산 그대로). 예: 동부산 소모품비(오픈 특이비용이 섞인 이력 대신 350만원)
function applyFix(code, leaf) {
  const fx = S.adj.filter(r => r.scope === code && r.mode === 'fix' && PNL_BY[r.account_code]);
  if (!fx.length) return leaf;
  const out = { ...leaf }; for (const r of fx) out[r.account_code] = +r.amount || 0;
  return out;
}
function adjLeaf(scope) {
  const out = {};
  for (const r of S.adj) if (r.scope === scope && (!r.mode || r.mode === 'add') && PNL_BY[r.account_code]) out[r.account_code] = (out[r.account_code] || 0) + (+r.amount || 0);
  return out;
}
const addLeaf = (a, b) => { const o = { ...a }; for (const k of Object.keys(b)) o[k] = (o[k] || 0) + b[k]; return o; };

// 모든 열 값 계산: 매장별(특이 포함) · 매장합계 · 안분(데이터 대기) · 브랜드 특이
function computeAll() {
  const D = S.D, store = {}, metas = {};
  let sum = {};
  const leaves = {};                       // 매장별 말단 값 — 예상 스냅샷 저장·피드백 비교용
  const mSum = { gen: {}, prem: {} };      // 모델별(일반 매장 / 프리미엄 매장) 합 — 매장 탭에서 선택 매장과 같은 모델 열로 쓴다
  for (const c of STORES) {
    const b = baseLeaf(c); metas[c] = b.meta;
    const leaf = addLeaf(applyFix(c, applySets(c, b.leaf)), adjLeaf(c));
    leaves[c] = leaf;
    store[c] = evalTree(leaf);
    sum = addLeaf(sum, leaf);
    const mk = storeModel(c); mSum[mk] = addLeaf(mSum[mk], leaf);
  }
  const total = evalTree(sum);
  const model = { gen: evalTree(mSum.gen), prem: evalTree(mSum.prem) };
  const alloc = evalTree({ ...estAllocLeaves(), [PNL_ID.true_ded]: TRUE_NET_DED, [PNL_ID.int_inc]: INT_INC_EST, [PNL_ID.fin_cost]: FIN_COST_EST });   // 안분비 = 법인 안분(직전 3개월 평균) + 브랜드 안분(최근 달) + 금융손익·진이익 차감
  const special = evalTree(adjLeaf('brand'));
  const brand = {};
  for (const a of PNL_ACC) brand[a.code] = total[a.code] + alloc[a.code] + special[a.code];
  // 세전이익이 음수면 법인세비용 0 — 열을 더한 값이 아니라 예상실적 열 자체의 세전이익으로 다시 계산 (양수일 때는 열 합과 같다)
  if (brand.pretax <= 0) { brand.tax = 0; brand.net = brand.pretax; brand.true_net = brand.net - brand.true_ded; }
  return { store, total, alloc, special, brand, metas, model, leaves };
}
// 매장 모델 — 로운샤브 프리미엄 매장(EST_PREMIUM) / 그 밖은 일반 매장
const storeModel = c => (typeof EST_PREMIUM !== 'undefined' && EST_PREMIUM.has(c)) ? 'prem' : 'gen';
const MODEL_NAME = { gen: '일반 매장', prem: '프리미엄 매장' };

// ---------- 표시 ----------
const nf = v => { const r = Math.round(v); if (!r) return '<span class="z">-</span>'; return r < 0 ? '(' + Math.abs(r).toLocaleString('ko-KR') + ')' : r.toLocaleString('ko-KR'); };
const pf = (v, base) => (!base || !Math.round(v)) ? '' : (v / base * 100).toFixed(1) + '%';

function hasVisibleChild(a, mode) {
  if (mode === 'l1') return false;
  return a.children.some(c => mode === 'all' || PNL_BY[c].main);
}
// "대분류만" 보기 — 계정 트리의 1단계가 아니라 사용자가 정한 요약 줄들 (원가·인건비·제조경비는 매출원가의 (1-1)(1-2)(1-3))
const L1_ROWS = [
  ['gross', '외형매출'], ['cogs.2', '원가'], ['cogs.3', '인건비'], ['cogs.4', '제조경비'], ['gp', '매출총이익'],
  ['sga', '판관비'], ['op', '영업이익'], ['net', '당기순이익'], ['true_net', '진이익', '당기순이익 − 72백만원(추정)']
];
const L1_PSEUDO = L1_ROWS.map(([code, label, pend]) => ({ code, label, pend, level: 1, children: [], calc: null, main: false, id: PNL_BY[code].id }));
const STORE_HIDE = new Set(['net', 'true_net', 'true_ded']);   // 매장 탭은 영업이익까지 (당기순이익·진이익은 브랜드 전체 값)
function visibleRows(mode, forStore) {
  if (mode === 'l1') return L1_PSEUDO;
  const out = [];
  for (const a of PNL_ACC) {
    if (forStore && STORE_HIDE.has(a.code)) continue;
    if (mode === 'main' && !a.main) continue;
    let p = a.parent, hide = false;
    while (p) { if (S.folded.has(p)) { hide = true; break; } p = PNL_BY[p].parent; }
    if (hide) continue;
    out.push(a);
  }
  return out;
}
// foldKey: 접기 상태를 저장하는 키 (계정이면 계정 코드, 영업이익 밑 안분 줄들은 'op_ex')
function labelCell(a, mode, foldKey) {
  const key = foldKey || (hasVisibleChild(a, mode) ? a.code : null);
  const caret = key ? `<span class="car">${S.folded.has(key) ? '▸' : '▾'}</span>` : '<span class="car"></span>';
  const pend = a.pend ? ` <span class="pend">${a.pend}</span>` : '';
  return `<td class="nm${key ? ' has' : ''}"${key ? ` data-fold="${key}"` : ''} data-code="${a.code}" style="padding-left:${6 + (a.level - 1) * 14}px">${caret}${esc(a.label)}${pend}</td>`;
}
const rowCls = a => `l${a.level}${a.children.length || a.calc ? ' sub' : ' lf'}${a.main ? ' mn' : ''}${['gp', 'op', 'net', 'true_net'].includes(a.id) ? ' key' : ''}`;

function renderAll() {
  document.querySelectorAll('#plMode button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  document.querySelectorAll('#plScope button').forEach(b => b.classList.toggle('on', b.dataset.scope === S.scope));
  $('plPickWrap').hidden = !((S.tab === 'store' || S.tab === 'fcst' || S.tab === 'fb') && S.scope === 'one');
  if (!S.D) return;
  const C = computeAll();
  S.C = C;
  renderBrand(C); renderStore(C); renderFcst(); renderFb(); renderSubmit(); renderActual(C); renderNotes(C); renderAdjust();
  document.querySelectorAll('td.nm[data-fold]').forEach(td => {
    td.onclick = () => { const k = td.dataset.fold; if (S.folded.has(k)) S.folded.delete(k); else S.folded.add(k); renderAll(); };
  });
  document.querySelectorAll('td[data-ed]').forEach(td => { td.onclick = () => startEdit(td); });
}

// ---------- 특이비용 직접 입력 (브랜드 표의 특이비용 칸) ----------
// 비용 계정(매출원가·판관비·영업외)의 맨 아래 계정만 고칠 수 있다. 하위 계정이 숨겨진 줄(예: 지급수수료)은 첫 하위 계정에 넣는다.
// 칸에 쓴 값 = 그 줄의 특이비용 합계가 되도록, 차이만큼을 '표에서 직접 입력' 한 줄에 더하거나 뺀다 (폼으로 넣은 다른 줄은 그대로).
const EDIT_ROOTS = new Set(['cogs', 'sga', 'other', 'fin']);
const rootOf = a => { let x = a; while (x.parent) x = PNL_BY[x.parent]; return x; };
const firstLeaf = a => a.children.length ? firstLeaf(PNL_BY[a.children[0]]) : a;
const editable = (a, mode) => mode !== 'l1' && !a.calc && !hasVisibleChild(a, mode) && EDIT_ROOTS.has(rootOf(a).code);

function startEdit(td) {
  if (td.querySelector('input')) return;
  const a = PNL_BY[td.dataset.ed];
  const cur = Math.round(S.C.special[a.code]);
  td.innerHTML = `<input class="edin" type="text" inputmode="numeric" value="${cur || ''}">`;
  const inp = td.firstChild; inp.focus(); inp.select();
  let done = false;
  const finish = ok => { if (done) return; done = true; if (ok) saveSpecial(a, inp.value); else renderAll(); };
  inp.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}
async function saveSpecial(a, text) {
  const t = String(text).trim().replace(/,/g, '');
  const nv = t === '' ? 0 : Number(t);
  if (!isFinite(nv)) { setMsg('숫자를 입력해 주세요.', true); renderAll(); return; }
  const diff = Math.round(nv) - Math.round(S.C.special[a.code]);
  if (!diff) { renderAll(); return; }
  const target = firstLeaf(a).code;
  const ex = S.adj.find(r => r.scope === 'brand' && r.account_code === target && r.note === MANUAL_NOTE);
  setMsg('저장 중…');
  let error;
  if (ex) {
    const amt = (+ex.amount || 0) + diff;
    ({ error } = amt ? await sb.from('pnl_adjust').update({ amount: amt }).eq('id', ex.id) : await sb.from('pnl_adjust').delete().eq('id', ex.id));
  } else {
    ({ error } = await sb.from('pnl_adjust').insert({ ym: S.ym, scope: 'brand', account_code: target, amount: diff, note: MANUAL_NOTE }));
  }
  if (error) { setMsg('저장 실패: ' + error.message, true); renderAll(); return; }
  S.adj = await loadAdjust(S.ym);
  setMsg('');
  renderAll();
}

function renderBrand(C) {
  const cols = [['예상실적', C.brand], ['매장', C.total], ['안분비', C.alloc], ['특이비용', C.special]];
  const W = 260 + cols.length * (124 + 64);
  let h = `<table class="pnl" style="width:100%;min-width:${W}px"><colgroup><col style="width:260px">${cols.map(() => '<col style="width:124px"><col style="width:64px">').join('')}</colgroup><thead><tr><th>로운 · ${S.ym.slice(0, 4)}년 ${+S.ym.slice(5)}월 예상</th>` +
    cols.map(([n]) => `<th class="num">${n}</th><th class="num">비율</th>`).join('') + '</tr></thead><tbody>';
  for (const a of visibleRows(S.mode)) {
    const ed = editable(a, S.mode);
    h += `<tr class="${rowCls(a)}">${labelCell(a, S.mode)}` + cols.map(([n, M]) => {
      const cell = S.planner && ed && n === '특이비용';   // 표에서 직접 입력은 기획자만
      return `<td class="num${cell ? ' ed' : ''}"${cell ? ` data-ed="${a.code}" title="눌러서 직접 입력 (Enter 저장, Esc 취소)"` : ''}>${nf(M[a.code])}</td><td class="num r">${a.code === 'gross' ? '' : pf(M[a.code], M.sales)}</td>`;   // 외형매출 줄은 비율 칸 비움 (비율 기준은 매출액 = 외형 ÷ 1.1)
    }).join('') + '</tr>';
  }
  $('brandTable').innerHTML = h + '</tbody></table>';
}

// 월별 실적 추이 — 받은 실적(백만원) + 선택한 월의 예상실적 열. 금액 / 매출 대비 % 전환
const ymLabel = ym => `${ym.slice(2, 4)}년${+ym.slice(5)}월`;
function renderStore(C) {
  const one = S.scope === 'one';
  if (!S.pick || !C.store[S.pick]) S.pick = STORES[0];
  const pickSel = $('plPick');
  if (pickSel.options.length !== STORES.length) pickSel.innerHTML = STORES.map(c => `<option value="${c}">${esc(sname(c))}</option>`).join('');
  pickSel.value = S.pick;
  // 매장 선택: 비고 | 로운(브랜드 전체) | 같은 모델 합계 | 선택 매장 — 열을 붙여서 한눈에 비교
  const mk = storeModel(S.pick);
  const colsDef = one ? [['sum', '로운', '', C.total], ['model', MODEL_NAME[mk], '모델', C.model[mk]], [S.pick, sname(S.pick), S.pick, C.store[S.pick]]]
                      : [['sum', '로운', '', C.total], ...STORES.map(c => [c, sname(c), c, C.store[c]])];
  const cw = one ? 128 : 112, pw = one ? 62 : 60;
  const W = 250 + colsDef.length * (cw + pw);
  let h = `<table class="pnl" style="${one ? `width:${W}px` : `width:100%;min-width:${W}px`}"><colgroup><col style="width:250px">${colsDef.map(() => `<col style="width:${cw}px"><col style="width:${pw}px">`).join('')}</colgroup><thead>` +
    `<tr><th>매장코드</th>${colsDef.map(([, , code]) => `<th colspan="2" class="ctr">${code || '합계'}</th>`).join('')}</tr>` +
    `<tr><th>매장명</th>${colsDef.map(([, n]) => `<th colspan="2" class="ctr">${esc(n)}</th>`).join('')}</tr>` +
    `<tr><th>비고</th>${colsDef.map(() => '<th class="num">금액(원)</th><th class="num">비율</th>').join('')}</tr></thead><tbody>`;
  for (const a of visibleRows('main', true)) {
    h += `<tr class="${rowCls(a)}">${labelCell(a, 'main', a.id === 'op' ? 'op_ex' : null)}` + colsDef.map(([, , , M]) => `<td class="num">${nf(M[a.code])}</td><td class="num r">${pf(M[a.code], M.sales)}</td>`).join('') + '</tr>';
  }
  // 영업이익 밑: 브랜드 안분비·법인 안분비 — 브랜드·법인 안분 합계를 매장 순매출 비율로 나눈다 → 안분 후 영업이익 (영업이익 줄을 눌러 접고 펼침)
  const AL = estAllocTotals(), totNet = C.total.sales || 0;
  const allocOf = (M, kind) => AL && totNet ? -(AL[kind] * (M.sales || 0) / totNet) : null;
  const allocCells = (M, kind) => { const v = allocOf(M, kind); return v == null ? '<td class="num"><span class="z">-</span></td><td class="num r"></td>' : `<td class="num">${nf(v)}</td><td class="num r">${pf(v, M.sales)}</td>`; };
  if (!S.folded.has('op_ex')) {
    for (const [n, kind] of [['브랜드 안분비', 'brand'], ['법인 안분비', 'corp']]) h += `<tr class="l1 lf ex"><td class="nm" style="padding-left:20px"><span class="car"></span>${n} <span class="pend">${AL ? '매출 비례 안분' : '데이터 대기'}</span></td>` + colsDef.map(([, , , M]) => allocCells(M, kind)).join('') + '</tr>';
  }
  h += `<tr class="l1 sub key"><td class="nm" style="padding-left:6px"><span class="car"></span>안분 후 영업이익</td>` + colsDef.map(([, , , M]) => { const v = M.op + (allocOf(M, 'brand') || 0) + (allocOf(M, 'corp') || 0); return `<td class="num">${nf(v)}</td><td class="num r">${pf(v, M.sales)}</td>`; }).join('') + '</tr>';
  $('storeTable').innerHTML = h + '</tbody></table>';
}

// ---------- 매장예측 (점장님이 직접 예상해 적는 손익) ----------
// 말단 계정 금액은 pnl_store_forecast(ym·매장·계정)에 저장한다. 하위 계정이 숨겨진 줄(소모품비·견본비 등)은 첫 하위 계정에 넣고,
// 계획 글은 화면에 보이는 줄의 코드에 저장한다. 매장 값은 기획자·매장 관리자 누구나 입력할 수 있다 (매장별 잠금 없음).
async function loadForecast(ym) {
  const data = await pageAll((a, b) => sb.from('pnl_store_forecast').select('store_code,account_code,amount,plan').eq('ym', ym).order('store_code').order('account_code').range(a, b));
  const amt = {}, plan = {};
  for (const r of data) {
    if (r.amount != null) (amt[r.store_code] = amt[r.store_code] || {})[r.account_code] = +r.amount;
    if (r.plan) (plan[r.store_code] = plan[r.store_code] || {})[r.account_code] = r.plan;
  }
  return { amt, plan };
}
const fcEditable = a => !a.calc && !hasVisibleChild(a, 'main') && (EDIT_ROOTS.has(rootOf(a).code) || rootOf(a).code === 'sales');
function fcLeaves(code) {
  const leaf = { ...(S.fc.amt[code] || {}) };
  if (leaf.gross_direct) leaf.vat = leaf.gross_direct / 11;   // 부가세 = 외형매출 ÷ 11 (매출액 = 외형매출 ÷ 1.1)
  return leaf;
}
function computeForecast() {
  const store = {}, mSum = { gen: {}, prem: {} };
  let sum = {};
  for (const c of STORES) {
    const leaf = fcLeaves(c);
    store[c] = evalTree(leaf);
    sum = addLeaf(sum, leaf);
    const mk = storeModel(c); mSum[mk] = addLeaf(mSum[mk], leaf);
  }
  return { store, total: evalTree(sum), model: { gen: evalTree(mSum.gen), prem: evalTree(mSum.prem) } };
}
const fcFilled = c => Object.values(S.fc.amt[c] || {}).some(v => v);
function fcAutoH(el) { el.style.height = 'auto'; el.style.height = Math.max(24, el.scrollHeight) + 'px'; }

function renderFcst() {
  const box = $('fcstTable'); if (!box) return;
  const act = document.activeElement;
  if (act && box.contains(act) && (act.tagName === 'TEXTAREA' || act.tagName === 'INPUT')) return;   // 입력 중에는 다시 그리지 않는다 (쓰던 글이 사라지지 않게)
  const F = computeForecast(); S.F = F;
  const one = S.scope === 'one';
  if (!S.pick || !F.store[S.pick]) S.pick = STORES[0];
  const filled = STORES.filter(fcFilled).length;
  $('fcStat').innerHTML = `${S.ym.slice(0, 4)}년 ${+S.ym.slice(5)}월 · 점장님 예상 입력 <b>${filled} / ${STORES.length}</b>개 매장${one ? '' : ' — 매장 이름을 누르면 그 매장 입력 화면으로 이동합니다.'}`;
  const mk = storeModel(S.pick);
  const colsDef = one ? [['sum', '로운', '합계', F.total], ['model', MODEL_NAME[mk], '모델', F.model[mk]], [S.pick, sname(S.pick), S.pick, F.store[S.pick]]]
                      : [['sum', '로운', '합계', F.total], ...STORES.map(c => [c, sname(c), c, F.store[c]])];
  const cw = one ? 128 : 112, pw = one ? 62 : 60, planW = 380;
  const W = 250 + colsDef.length * (cw + pw) + (one ? planW : 0);
  const planTh = one ? '<th rowspan="3" class="ctr" style="vertical-align:middle;white-space:normal;line-height:1.5">EBG 계획</th>' : '';
  let h = `<table class="pnl" style="width:100%;min-width:${W}px"><colgroup><col style="width:250px">${colsDef.map(() => `<col style="width:${cw}px"><col style="width:${pw}px">`).join('')}${one ? `<col style="min-width:${planW}px">` : ''}</colgroup><thead>` +
    `<tr><th>매장코드</th>${colsDef.map(([, , code]) => `<th colspan="2" class="ctr">${esc(code)}</th>`).join('')}${planTh}</tr>` +
    `<tr><th>매장명</th>${colsDef.map(([id, n]) => `<th colspan="2" class="ctr"${!one && id !== 'sum' ? ` data-go="${id}" style="cursor:pointer" title="눌러서 이 매장 입력하기"` : ''}>${esc(n)}${!one && id !== 'sum' && !fcFilled(id) ? ' <span class="pend" style="color:#cbd5e1">미입력</span>' : ''}</th>`).join('')}</tr>` +
    `<tr><th>비고</th>${colsDef.map(() => '<th class="num">금액(원)</th><th class="num">비율</th>').join('')}</tr></thead><tbody>`;
  for (const a of visibleRows('main', true)) {
    const ed = one && fcEditable(a);
    h += `<tr class="${rowCls(a)}">${labelCell(a, 'main')}` + colsDef.map(([id, , , M], i) => {
      const cell = ed && i === 2;
      return `<td class="num${cell ? ' ed' : ''}"${cell ? ` data-fe="${a.code}" title="눌러서 입력 (Enter 저장, Esc 취소)"` : ''}>${nf(M[a.code])}</td><td class="num r">${pf(M[a.code], M.sales)}</td>`;
    }).join('');
    if (one) h += `<td class="plan"><textarea class="plin" rows="1" data-pl="${a.code}" placeholder="원인/대안">${esc((S.fc.plan[S.pick] || {})[a.code] || '')}</textarea></td>`;
    h += '</tr>';
  }
  box.innerHTML = h + '</tbody></table>';
  box.querySelectorAll('th[data-go]').forEach(th => { th.onclick = () => { S.scope = 'one'; S.pick = th.dataset.go; renderAll(); }; });
  box.querySelectorAll('td[data-fe]').forEach(td => { td.onclick = () => startFcEdit(td); });
  box.querySelectorAll('textarea.plin').forEach(t => {
    fcAutoH(t);
    t.oninput = () => fcAutoH(t);
    t.onblur = () => fcSavePlan(S.pick, t.dataset.pl, t.value);
  });
}
function startFcEdit(td) {
  if (td.querySelector('input')) return;
  const a = PNL_BY[td.dataset.fe], store = S.pick;
  const cur = Math.round(S.F.store[store][a.code]);
  td.innerHTML = `<input class="edin" type="text" inputmode="numeric" value="${cur || ''}">`;
  const inp = td.firstChild; inp.focus(); inp.select();
  let done = false;
  const finish = ok => { if (done) return; done = true; const v = inp.value; inp.blur(); if (ok) fcSaveAmount(store, a, v); else renderAll(); };   // blur로 포커스를 먼저 풀어야 renderFcst가 다시 그린다
  inp.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}
async function fcSaveAmount(store, a, text) {
  const t = String(text).trim().replace(/,/g, '');
  const nv = t === '' ? null : Math.round(Number(t));
  if (nv !== null && !isFinite(nv)) { setMsg('숫자를 입력해 주세요.', true); renderAll(); return; }
  const leaf = firstLeaf(a).code, m = S.fc.amt[store] || (S.fc.amt[store] = {});
  if ((m[leaf] == null ? null : m[leaf]) === nv) { renderAll(); return; }
  setMsg('저장 중…');
  const { error } = await sb.from('pnl_store_forecast').upsert({ ym: S.ym, store_code: store, account_code: leaf, amount: nv }, { onConflict: 'ym,store_code,account_code' });
  if (error) { setMsg('저장 실패: ' + error.message, true); renderAll(); return; }
  if (nv === null) delete m[leaf]; else m[leaf] = nv;
  setMsg('저장했습니다');
  setTimeout(() => { if ($('plMsg').textContent === '저장했습니다') setMsg(''); }, 1500);
  renderAll();
}
async function fcSavePlan(store, code, text) {
  const t = String(text).trim(), m = S.fc.plan[store] || (S.fc.plan[store] = {});
  if (t === (m[code] || '')) return;
  setMsg('저장 중…');
  const { error } = await sb.from('pnl_store_forecast').upsert({ ym: S.ym, store_code: store, account_code: code, plan: t || null }, { onConflict: 'ym,store_code,account_code' });
  if (error) { setMsg('저장 실패: ' + error.message, true); return; }
  if (t) m[code] = t; else delete m[code];
  setMsg('저장했습니다');
  setTimeout(() => { if ($('plMsg').textContent === '저장했습니다') setMsg(''); }, 1500);
}

// ---------- 피드백: 월 확정 실적(전표) vs 매장(예상) vs 매장예측(점장님 예상) ----------
// 월말에 쓴다. 확정 실적 = 그 달 전표(매장 전표 + 매장 매출). 매장(예상) = 월초에 저장해 둔 예상 스냅샷(없으면 지금 다시 계산한 값 — 실적이 섞여 차이가 작아 보일 수 있음).
// GAP = 확정 − 예상(또는 확정 − 점장 예상): + 이면 실제가 더 컸다. 계정(말단 줄)별 GAP이 5백만원 이상이면 아래 목록에 올라와 차이 원인을 적는다.
const FB_GAP_MIN = 5000000;
async function loadFb(ym) {
  const [g, s, sn, rs] = await Promise.all([
    pageAll((a, b) => sb.rpc('gl_monthly_stores', { p_from: ym }).order('ym').order('store_code').order('leaf').range(a, b)),
    sb.rpc('store_sales_all', { p_from: ym }),
    pageAll((a, b) => sb.from('pnl_store_est_snap').select('store_code,account_code,amount,snapped_at').eq('ym', ym).order('store_code').order('account_code').range(a, b)),
    pageAll((a, b) => sb.from('pnl_fb_reason').select('store_code,account_code,reason').eq('ym', ym).order('store_code').order('account_code').range(a, b))
  ]);
  if (s.error) throw s.error;
  const act = {}; let nVoucher = 0;
  for (const r of g) { if (r.ym !== ym) continue; nVoucher++; (act[r.store_code] = act[r.store_code] || {})[r.leaf] = +r.amount; }
  for (const L of Object.values(act)) L.food = (L.food_gross || 0) - GL_MFG.reduce((t, k) => t + (L[k] || 0), 0) - (L.skip72 || 0);   // 식재료원가 = 총 식재료 − 제조 계정 − 72 (실적 추이와 같은 규칙)
  for (const r of s.data || []) if (r.ym === ym) { const L = act[r.store_code] = act[r.store_code] || {}, gr = +r.gross || 0; L.gross_direct = gr; L.vat = gr - gr / 1.1; }
  const snap = {}; let snapAt = '';
  for (const r of sn) { (snap[r.store_code] = snap[r.store_code] || {})[r.account_code] = +r.amount; if (r.snapped_at > snapAt) snapAt = r.snapped_at; }
  const reason = {};
  for (const r of rs) if (r.reason) (reason[r.store_code] = reason[r.store_code] || {})[r.account_code] = r.reason;
  return { ym, state: 'ready', act, nVoucher, snap, snapN: sn.length, snapAt, reason };
}
function fbModel() {
  const FC = computeForecast(), useSnap = S.fb.snapN > 0;
  const actL = {}, estL = {};
  for (const c of STORES) { actL[c] = S.fb.act[c] || {}; estL[c] = useSnap ? (S.fb.snap[c] || {}) : (S.C.leaves[c] || {}); }
  const M = { act: {}, est: {}, fc: { ...FC.store } };
  let sa = {}, se = {}, sfa = {};
  const filled = STORES.filter(fcFilled);
  for (const c of STORES) { M.act[c] = evalTree(actL[c]); M.est[c] = evalTree(estL[c]); sa = addLeaf(sa, actL[c]); se = addLeaf(se, estL[c]); }
  filled.forEach(c => { sfa = addLeaf(sfa, actL[c]); });
  M.act.sum = evalTree(sa); M.est.sum = evalTree(se); M.fc.sum = FC.total;
  M.actF = evalTree(sfa);   // 점장님이 입력한 매장만 모은 확정 실적 — 합계 보기에서 GAP(매장예측)을 같은 매장끼리 비교하려고
  return { M, filled, useSnap };
}
const fbGapCell = v => {
  if (v == null || !Math.round(v)) return '<td class="num"><span class="z">-</span></td>';
  const big = Math.abs(v) >= FB_GAP_MIN;
  return `<td class="num"${big ? ' style="color:var(--crit);font-weight:700"' : ''}>${v > 0 ? '+' : ''}${nf(v)}</td>`;
};
function renderFb() {
  const box = $('fbTable'); if (!box) return;
  const act = document.activeElement;
  if (act && ($('view-fb').contains(act)) && (act.tagName === 'TEXTAREA' || act.tagName === 'INPUT')) return;   // 글을 쓰는 중에는 다시 그리지 않는다
  if (S.tab !== 'fb') return;
  if (!S.fb || S.fb.ym !== S.ym) {
    if (!S.fb || S.fb.state !== 'loading' || S.fb.ym !== S.ym) {
      const ym = S.ym; S.fb = { ym, state: 'loading' };
      box.innerHTML = '<p class="dnote" style="padding:12px">확정 실적(전표)과 예상 스냅샷을 불러오는 중…</p>'; $('fbReasons').innerHTML = ''; $('fbBar').innerHTML = '';
      loadFb(ym).then(d => { if (S.ym === ym) { S.fb = d; renderFb(); } }).catch(e => { if (S.ym === ym) { S.fb = { ym, state: 'error' }; box.innerHTML = `<p class="dnote" style="padding:12px;color:var(--crit)">불러오지 못했습니다: ${esc(e.message || e)}</p>`; } });
    }
    return;
  }
  if (S.fb.state !== 'ready') return;
  const { M, filled, useSnap } = fbModel();
  const one = S.scope === 'one', key = one ? S.pick : 'sum', nFilled = filled.length;
  const hasAct = S.fb.nVoucher > 0, ymL = `${S.ym.slice(0, 4)}년 ${+S.ym.slice(5)}월`;
  const snapTxt = useSnap ? `저장된 스냅샷 (${new Date(S.fb.snapAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })})` : '<span style="color:var(--warn)">저장된 스냅샷 없음 — 지금 다시 계산한 값</span>';
  $('fbBar').innerHTML = `<div class="dnote" style="margin:0 0 6px">${ymL} · 확정 실적: ${hasAct ? '전표 반영' : '<span style="color:var(--crit)">이 달 전표가 아직 없어 비어 있습니다 (전표 업로드 후 채워짐)</span>'} · 매장(예상): ${snapTxt} · 매장예측: 점장님 입력 ${nFilled} / ${STORES.length}개 매장${one ? '' : ' (GAP(매장예측)은 입력한 매장끼리만 비교)'}` +
    (S.planner ? ` <button id="fbSnapBtn" class="btn btn-sm" type="button" style="margin-left:10px">${useSnap ? '예상 스냅샷 다시 저장' : '지금 예상을 스냅샷으로 저장'}</button>` : '') + '</div>' +
    (useSnap ? '' : '<div class="dnote" style="margin:0 0 6px;color:var(--warn)">월초에 "지금 예상을 스냅샷으로 저장"을 눌러 두면, 월말에 그때의 예상과 확정 실적을 비교할 수 있습니다. 저장하지 않은 채 월말에 보면 예상이 실적을 반영해 다시 계산돼 차이가 작게 나옵니다.</div>');
  if ($('fbSnapBtn')) $('fbSnapBtn').onclick = fbSaveSnap;
  const Ma = M.act[key], Me = M.est[key], Mf = M.fc[key];
  const fcOk = one ? fcFilled(S.pick) : nFilled > 0;
  const Maf = one ? Ma : M.actF;   // 합계 보기의 GAP(매장예측)은 입력한 매장의 확정 실적과 비교
  const rows = visibleRows('main', true);
  let h = `<table class="pnl" style="width:100%;min-width:${250 + 5 * 140}px"><colgroup><col style="width:250px">${'<col style="width:140px">'.repeat(5)}</colgroup><thead>` +
    `<tr><th>${one ? esc(sname(S.pick)) : '로운 (전체 매장 합계)'} · ${ymL}</th><th class="num">월 확정 실적</th><th class="num">매장(예상)</th><th class="num">매장예측(점장님)</th><th class="num" title="확정 실적 − 매장(예상). +이면 실제가 더 컸음">GAP(매장)</th><th class="num" title="확정 실적 − 매장예측(점장님). +이면 실제가 더 컸음">GAP(매장예측)</th></tr>` +
    `<tr><th>비고</th><th class="num">금액(원)</th><th class="num">금액(원)</th><th class="num">금액(원)</th><th class="num">확정 − 예상</th><th class="num">확정 − 점장예측</th></tr></thead><tbody>`;
  for (const a of rows) {
    const v = Ma[a.code] || 0, e = Me[a.code] || 0, f = Mf[a.code] || 0;
    h += `<tr class="${rowCls(a)}">${labelCell(a, 'main')}<td class="num">${nf(v)}</td><td class="num">${nf(e)}</td><td class="num">${fcOk ? nf(f) : '<span class="z">-</span>'}</td>` +
      fbGapCell(hasAct ? v - e : null) + fbGapCell(hasAct && fcOk ? (Maf[a.code] || 0) - f : null) + '</tr>';
  }
  box.innerHTML = h + '</tbody></table>';
  box.querySelectorAll('td.nm[data-fold]').forEach(td => { td.onclick = () => { const k = td.dataset.fold; if (S.folded.has(k)) S.folded.delete(k); else S.folded.add(k); renderFb(); }; });

  // ----- 맨 아래: 차이 5백만원 이상 계정 → 차이 원인 기술 -----
  const items = [];
  if (hasAct) for (const c of (one ? [S.pick] : STORES)) {
    const ok = fcFilled(c);
    for (const a of rows) {
      if (!fcEditable(a)) continue;
      const v = M.act[c][a.code] || 0, e = M.est[c][a.code] || 0, f = M.fc[c][a.code] || 0;
      const gE = v - e, gF = ok ? v - f : null;
      if (Math.abs(gE) >= FB_GAP_MIN || (gF != null && Math.abs(gF) >= FB_GAP_MIN)) items.push({ c, a, v, e, f: ok ? f : null, gE, gF, max: Math.max(Math.abs(gE), gF != null ? Math.abs(gF) : 0) });
    }
  }
  items.sort((x, y) => y.max - x.max);
  const sg = v => v == null ? '<span class="z">-</span>' : (v > 0 ? '+' : '') + nf(v).replace('<span class="z">-</span>', '0');
  const gcell = v => v != null && Math.abs(v) >= FB_GAP_MIN ? 'style="color:var(--crit);font-weight:700"' : '';
  $('fbReasons').innerHTML = `<h3 style="margin:22px 0 6px">차이 원인 기술 <span style="font-weight:400;font-size:12px;color:var(--muted)">GAP(매장) 또는 GAP(매장예측)이 ${FB_GAP_MIN / 10000}만원 이상인 계정</span></h3>` +
    (!hasAct ? '<p class="dnote">확정 실적(전표)이 아직 없어 차이를 계산할 수 없습니다.</p>' :
     !items.length ? '<p class="dnote">차이가 5백만원 이상 나는 계정이 없습니다.</p>' :
     `<p class="dnote" style="margin:0 0 8px">${one ? '' : '전체 매장 중 해당하는 계정이 매장별로 모두 나옵니다. '}원인을 적으면 자동 저장됩니다 (기획자·점장님 누구나 입력).</p><div class="pnlwrap"><table class="pnl" style="width:100%;min-width:1000px"><colgroup><col style="width:90px"><col style="width:190px"><col style="width:110px"><col style="width:110px"><col style="width:110px"><col style="width:110px"><col style="width:110px"><col style="min-width:300px"></colgroup>` +
     '<thead><tr><th>매장</th><th>계정</th><th class="num">월 확정</th><th class="num">매장(예상)</th><th class="num">매장예측</th><th class="num">GAP(매장)</th><th class="num">GAP(매장예측)</th><th>차이 원인</th></tr></thead><tbody>' +
     items.map(it => `<tr><td class="nm" style="padding-left:8px">${esc(sname(it.c))}</td><td class="nm" style="padding-left:8px">${esc(it.a.label.replace(/^[①-⑮]\s*/, ''))}</td><td class="num">${nf(it.v)}</td><td class="num">${nf(it.e)}</td><td class="num">${it.f == null ? '<span class="z">-</span>' : nf(it.f)}</td><td class="num" ${gcell(it.gE)}>${sg(it.gE)}</td><td class="num" ${gcell(it.gF)}>${sg(it.gF)}</td>` +
       `<td class="plan"><textarea class="plin" rows="1" data-fs="${it.c}" data-fa="${it.a.code}" placeholder="차이 원인">${esc((S.fb.reason[it.c] || {})[it.a.code] || '')}</textarea></td></tr>`).join('') + '</tbody></table></div>');
  $('fbReasons').querySelectorAll('textarea.plin').forEach(t => {
    fcAutoH(t); t.oninput = () => fcAutoH(t);
    t.onblur = () => fbSaveReason(t.dataset.fs, t.dataset.fa, t.value);
  });
}
async function fbSaveReason(store, code, text) {
  const t = String(text).trim(), m = S.fb.reason[store] || (S.fb.reason[store] = {});
  if (t === (m[code] || '')) return;
  setMsg('저장 중…');
  const { error } = await sb.from('pnl_fb_reason').upsert({ ym: S.ym, store_code: store, account_code: code, reason: t || null }, { onConflict: 'ym,store_code,account_code' });
  if (error) { setMsg('저장 실패: ' + error.message, true); return; }
  if (t) m[code] = t; else delete m[code];
  setMsg('저장했습니다');
  setTimeout(() => { if ($('plMsg').textContent === '저장했습니다') setMsg(''); }, 1500);
}
// 월초에 누르는 버튼 — 지금 매장 탭의 매장별 예상(말단 계정 값)을 그 월의 기준으로 저장한다 (기획자)
async function fbSaveSnap() {
  if (!S.planner || !S.C) return;
  if (S.fb && S.fb.snapN && !confirm('이미 저장된 예상 스냅샷이 있습니다. 지금 계산값으로 다시 저장할까요? (기존 스냅샷은 지워집니다)')) return;
  setMsg('스냅샷 저장 중…');
  const rows = [];
  for (const c of STORES) for (const [k, v] of Object.entries(S.C.leaves[c] || {})) if (PNL_BY[k] && Math.round(v)) rows.push({ ym: S.ym, store_code: c, account_code: k, amount: Math.round(v) });
  const del = await sb.from('pnl_store_est_snap').delete().eq('ym', S.ym);
  if (del.error) { setMsg('스냅샷 저장 실패: ' + del.error.message, true); return; }
  for (let i = 0; i < rows.length; i += 300) {
    const { error } = await sb.from('pnl_store_est_snap').insert(rows.slice(i, i + 300));
    if (error) { setMsg('스냅샷 저장 실패: ' + error.message, true); return; }
  }
  S.fb = null; setMsg(`스냅샷을 저장했습니다 (${rows.length}행)`);
  setTimeout(() => { if ($('plMsg').textContent.startsWith('스냅샷을 저장')) setMsg(''); }, 2500);
  renderAll();
}

// ---------- 실적 제출 (기획자 전용): 월 실적을 KPI 표로 정리 → 엑셀로 내려받아 복사해 붙여넣기 ----------
// 왼쪽 7칸 = 그 달 브랜드 예상실적(브랜드 탭 값). 오른쪽 KPI = 목표(월말·기준일까지) / 실적(기준일까지 누적) / 전년(같은 기간) / 달성 = 실적−목표(기준일까지) / 성장 = 실적−전년.
// 자동 계산: 점당매출·식자재원가율·회전율·동일매장성장률·매장수·고객평점·인건비율. 직접 입력: 고객대기시간·재방문주기·피크타임점유율·EBG통과점장수·A점장후보수 (+ 자동값이 없는 칸).
// dir: +1 = 클수록 좋음, −1 = 작을수록 좋음 (달성·성장 글자 색). prorate = 월말 목표를 기준일까지 일할 계산.
const SUB_KPI = [
  { k: 'perstore', label: '점당매출', unit: '억원', dec: 2, dir: 1, prorate: 1, xz: '0.0' },
  { k: 'food', label: '식자재원가율', unit: '%', dec: 1, dir: -1, pct: 1 },
  { k: 'turn', label: '회전율', unit: '회', dec: 1, dir: 1, xz: '0.0' },
  { k: 'wait', label: '고객대기시간', unit: '분', dec: 1, dir: -1, manual: 1, xz: '0.0' },
  { k: 'cycle', label: '재방문주기', unit: '일', dec: 0, dir: -1, manual: 1, xz: '0' },
  { k: 'peak', label: '피크타임점유율', unit: '%', dec: 0, dir: 1, manual: 1, pct: 1 },
  { k: 'same', label: '동일매장성장률', unit: '%', dec: 1, dir: 1, pct: 1 },
  { k: 'stores', label: '매장수', unit: '개', dec: 0, dir: 1, xz: '0' },
  { k: 'rating', label: '고객평점', unit: '점', dec: 0, dir: 1, xz: '0' },
  { k: 'ebg', label: 'EBG통과점장수', unit: '명', dec: 0, dir: 1, manual: 1, xz: '0' },
  { k: 'acand', label: 'A점장후보수', unit: '명', dec: 0, dir: 1, manual: 1, xz: '0' },
  { k: 'labor', label: '인건비율', unit: '%', dec: 1, dir: -1, pct: 1 }
];
const SUB_LEFT = [['gross', '외형매출', '백만원'], ['sales', '실매출', '백만원'], ['mfg', '제조경비', '백만원'], ['gp', '매출총이익', '백만원'], ['op', '영업이익', '백만원'], ['labor', '인건비율', '%'], ['food', '원가율', '%']];
const SUB_COL = { t: 'target', a: 'actual', p: 'prev' };
const daysIn = ym => new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate();
const numOrNull = v => (v === '' || v == null || !isFinite(+v)) ? null : +v;
const subFmt = (v, d) => v == null ? '' : (+v).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });

async function loadSubmit(ym, to) {
  const [st, inp] = await Promise.all([
    sb.rpc('pnl_submit_stats', { p_from: ym + '-01', p_to: to || null }),
    pageAll((a, b) => sb.from('pnl_submit_input').select('ym,k,col,val').order('ym').order('k').order('col').range(a, b))
  ]);
  if (st.error) throw st.error;
  const all = {};
  for (const r of inp) { const o = all[r.ym] = all[r.ym] || {}; (o[r.k] = o[r.k] || {})[r.col] = r.val == null ? null : +r.val; }
  const saved = all[ym] || {};
  const hasT = Object.values(saved).some(x => x.target != null);
  const prevYms = Object.keys(all).filter(m => m < ym && Object.values(all[m]).some(x => x.target != null)).sort();
  const carry = {};   // 이 달 목표를 아직 저장하지 않았으면 직전에 저장한 달의 목표를 채워 둔다 (저장을 눌러야 이 달 값으로 남음)
  if (!hasT && prevYms.length) for (const [k, x] of Object.entries(all[prevYms[prevYms.length - 1]])) if (x.target != null) carry[k] = x.target;
  return { ym, state: 'ready', stats: st.data, to: st.data.to, last: st.data.last_date, saved, carry, carryFrom: hasT || !prevYms.length ? '' : prevYms[prevYms.length - 1] };
}

// 자동 계산값 (목표·직접 입력값은 화면 칸에서 읽는다)
function subAuto() {
  const d = S.sub.stats, C = S.C, B = C.brand, st = d.stores || [];
  const N = +String(d.to).slice(8, 10);
  const cs = st.filter(x => x.cur_days > 0), ps = st.filter(x => x.prev_days > 0);
  const sum = (a, f) => a.reduce((t, x) => t + (+f(x) || 0), 0);
  const per = (a, sk) => a.length ? sum(a, x => x[sk]) / a.length / 1e8 : null;
  const turn = (a, dk, gk) => { const cap = sum(a, x => (x[dk] || 0) * (x.seats || 0) * 0.7); return cap > 0 ? sum(a, x => x[gk]) / cap : null; };
  const same = st.filter(x => x.cur_days >= 0.9 * N && x.prev_days >= 0.9 * N);
  const sPrev = sum(same, x => x.prev_sales);
  const pa = S.act[shiftYm(S.ym, -12)];
  const ratio = (M, code) => M && M.sales ? (M[code] || 0) / M.sales * 100 : null;
  const rat = d.rating && d.rating.n > 0 ? +d.rating.avg * 20 : null;   // 5점 만점 평균 별점 → 100점 환산
  const A = {
    perstore: { a: per(cs, 'cur_sales'), p: per(ps, 'prev_sales') },
    food: { a: ratio(B, 'cogs.2'), p: ratio(pa, 'cogs.2') },
    turn: { a: turn(cs, 'cur_days', 'cur_guests'), p: turn(ps, 'prev_days', 'prev_guests') },
    same: { a: same.length >= 3 && sPrev > 0 ? (sum(same, x => x.cur_sales) / sPrev - 1) * 100 : null, p: null },
    stores: { a: cs.length, p: ps.length },
    rating: { a: rat, p: null },
    labor: { a: ratio(B, 'cogs.3'), p: ratio(pa, 'cogs.3') }
  };
  const L = { gross: B.gross / 1e6, sales: B.sales / 1e6, mfg: B['cogs.4'] / 1e6, gp: B.gp / 1e6, op: B.op / 1e6, labor: ratio(B, 'cogs.3'), food: ratio(B, 'cogs.2') };
  return { A, L, N, nSame: same.length };
}

function renderSubmit() {
  const box = $('subBody'); if (!box || S.tab !== 'submit' || !S.planner) return;
  const act = document.activeElement;
  if (act && $('view-submit').contains(act) && (act.tagName === 'INPUT')) return;   // 숫자를 입력하는 중에는 다시 그리지 않는다
  if (!S.sub || S.sub.ym !== S.ym || S.sub.reload) {
    if (!S.sub || S.sub.state !== 'loading' || S.sub.ym !== S.ym) {
      const ym = S.ym, same = S.sub && S.sub.ym === ym, to = same ? S.sub.pickTo : null, draft = same ? (S.sub.draft || {}) : {}; S.sub = { ym, state: 'loading', pickTo: to, draft };
      box.innerHTML = '<p class="dnote" style="padding:12px">매출·객수와 저장된 입력값을 불러오는 중…</p>';
      loadSubmit(ym, to).then(d => { if (S.ym === ym) { S.sub = { ...d, pickTo: to, draft }; renderSubmit(); } }).catch(e => { if (S.ym === ym) { S.sub = { ym, state: 'error', pickTo: to, draft }; box.innerHTML = `<p class="dnote" style="padding:12px;color:var(--crit)">불러오지 못했습니다: ${esc(e.message || e)}</p>`; } });
    }
    return;
  }
  if (S.sub.state !== 'ready') return;
  const { A, L, N } = subAuto(), sub = S.sub, saved = sub.saved, dim = daysIn(S.ym);
  const md = `${+sub.to.slice(5, 7)}.${+sub.to.slice(8, 10)}`, ymL = `${+S.ym.slice(5)}월`;
  const dr = sub.draft || (sub.draft = {});
  const inp = (k, c, v, ph) => { const dv = dr[`${k}.${c}`]; const x = dv !== undefined ? dv : v; return `<input class="subin" type="number" step="any" data-k="${k}" data-c="${c}" value="${x == null ? '' : x}"${ph ? ` placeholder="${ph}"` : ''}>`; };
  const left = SUB_LEFT.map(([k, lab, u]) => `<label class="sub-f"><span>${lab}${k === 'labor' || k === 'food' ? ' <small>(예상 기준)</small>' : ''}</span><span class="sub-v"><input class="subin ro" type="text" readonly value="${subFmt(L[k], u === '%' ? 1 : 0)}"><em>${u}</em></span></label>`).join('');
  const rows = SUB_KPI.map(d => {
    const au = A[d.k] || {}, tv = saved[d.k] && saved[d.k].target != null ? saved[d.k].target : (sub.carry[d.k] != null ? sub.carry[d.k] : null);
    const manA = d.manual || au.a == null, manP = d.manual || au.p == null;
    const sv = c => saved[d.k] && saved[d.k][c] != null ? saved[d.k][c] : null;
    const av = d.manual ? sv('actual') : au.a, pv = d.manual ? sv('prev') : au.p;
    const cellA = manA ? inp(d.k, 'a', d.manual ? sv('actual') : sv('actual'), '입력') : `<span class="sub-auto" data-k="${d.k}" data-c="a" data-v="${au.a}">${subFmt(au.a, d.dec)}</span>`;
    const cellP = manP ? inp(d.k, 'p', sv('prev'), '입력') : `<span class="sub-auto" data-k="${d.k}" data-c="p" data-v="${au.p}">${subFmt(au.p, d.dec)}</span>`;
    return `<tr data-row="${d.k}"><th class="lbl">${d.label} <small>${d.unit}</small></th><td>${inp(d.k, 't', tv)}</td><td class="num sub-tt"></td><td class="num">${cellA}</td><td class="num">${cellP}</td><td class="num sub-ach"></td><td class="num sub-gro"></td></tr>`;
  }).join('');
  box.innerHTML = `<div class="sub-grid"><div class="sub-left"><h3>${ymL} 예상</h3>${left}<p class="dnote">브랜드 탭의 ${ymL} 예상실적 값입니다 (매출액 대비 비율).</p></div>` +
    `<div class="sub-right"><table class="sub-kpi"><thead><tr><th>지표</th><th>목표<small>(월말)</small></th><th>목표<small>(~${md})</small></th><th>실적<small>(~${md})</small></th><th>전년<small>(같은 기간)</small></th><th>달성</th><th>성장</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="dnote">실적·전년은 ${+sub.to.slice(5, 7)}월 1일~${+sub.to.slice(8, 10)}일 누적(전년은 같은 날짜 범위)입니다. 달성 = 실적 − 목표(~${md}), 성장 = 실적 − 전년. 점당매출 목표(~${md})는 월말 목표를 ${N}/${dim}일로 나눈 값, 나머지 목표는 월말 값 그대로입니다.</p></div></div>`;
  $('subBar').innerHTML = `<label class="fld" style="min-width:150px">기준일<input id="subTo" type="date" min="${S.ym}-01" max="${lastDay(S.ym)}" value="${sub.to}"></label>` +
    `<button id="subSave" class="btn btn-sm" type="button">입력 저장</button><button id="subXls" class="btn btn-sm" type="button">엑셀 다운로드</button>` +
    `<span class="dnote" style="margin:0">매출·객수 최신 날짜: ${sub.last ? sub.last.slice(5).replace('-', '/') : '없음'}${sub.carryFrom ? ` · 목표는 ${+sub.carryFrom.slice(5)}월에 저장한 값을 채워 두었습니다` : ''}</span>`;
  $('subTo').onchange = () => { S.sub.pickTo = $('subTo').value; S.sub.reload = true; renderSubmit(); };
  $('subSave').onclick = saveSubmit; $('subXls').onclick = downloadSubmit;
  box.querySelectorAll('input.subin:not(.ro)').forEach(i => { i.oninput = () => { dr[`${i.dataset.k}.${i.dataset.c}`] = i.value; subRefresh(i.dataset.k); }; });
  SUB_KPI.forEach(d => subRefresh(d.k));
}
// 한 줄의 목표(~기준일)·달성·성장을 다시 계산한다 (칸에 숫자를 입력하는 대로)
function subCells(k) {
  const d = SUB_KPI.find(x => x.k === k), tr = document.querySelector(`#subBody tr[data-row="${k}"]`); if (!tr) return null;
  const val = c => { const i = tr.querySelector(`input[data-c="${c}"]`); if (i) return numOrNull(i.value); const s = tr.querySelector(`.sub-auto[data-c="${c}"]`); return s ? numOrNull(s.dataset.v === 'null' ? null : s.dataset.v) : null; };
  const t = val('t'), a = val('a'), p = val('p');
  const dim = daysIn(S.ym), N = +String(S.sub.to).slice(8, 10);
  const tt = t == null ? null : (d.prorate ? t * N / dim : t);
  return { d, tr, t, tt, a, p, ach: a != null && tt != null ? a - tt : null, gro: a != null && p != null ? a - p : null };
}
function subRefresh(k) {
  const c = subCells(k); if (!c) return;
  const sg = (v, dir) => { if (v == null) return ''; const r = Math.round(v * 10 ** c.d.dec) / 10 ** c.d.dec; const cls = r === 0 ? '' : ((r > 0) === (dir > 0) ? 'sub-good' : 'sub-bad'); return `<span class="${cls}">${r > 0 ? '+' : ''}${subFmt(r, c.d.dec)} ${c.d.unit}</span>`; };
  c.tr.querySelector('.sub-tt').textContent = c.tt == null ? '' : `${subFmt(c.tt, c.d.dec)}`;
  c.tr.querySelector('.sub-ach').innerHTML = sg(c.ach, c.d.dir);
  c.tr.querySelector('.sub-gro').innerHTML = sg(c.gro, c.d.dir);
}
async function saveSubmit() {
  setMsg('저장 중…');
  const rows = [];
  for (const d of SUB_KPI) {
    const c = subCells(d.k); if (!c) continue;
    for (const [short, col] of Object.entries(SUB_COL)) {
      const i = c.tr.querySelector(`input[data-c="${short}"]`); if (!i) continue;   // 자동 계산 칸은 저장하지 않는다
      const v = numOrNull(i.value); if (v != null) rows.push({ ym: S.ym, k: d.k, col, val: v });
    }
  }
  const del = await sb.from('pnl_submit_input').delete().eq('ym', S.ym);
  if (del.error) { setMsg('저장 실패: ' + del.error.message, true); return; }
  if (rows.length) { const { error } = await sb.from('pnl_submit_input').insert(rows); if (error) { setMsg('저장 실패: ' + error.message, true); return; } }
  S.sub.saved = {}; for (const r of rows) ((S.sub.saved[r.k] = S.sub.saved[r.k] || {})[r.col] = r.val); S.sub.carry = {}; S.sub.carryFrom = ''; S.sub.draft = {};
  setMsg(`저장했습니다 (${rows.length}칸)`);
  setTimeout(() => { if ($('plMsg').textContent.startsWith('저장했습니다')) setMsg(''); }, 1800);
}
// 엑셀: 왼쪽 위 '○월 예상' 아래로 7개 값, 오른쪽에 목표·목표(기준일까지)·실적·전년 12줄 — 그대로 복사해 붙여넣는 모양
function downloadSubmit() {
  if (!S.sub || S.sub.state !== 'ready') return;
  const { L } = subAuto();
  const cell = (v, z, pct) => v == null ? null : { t: 'n', v: pct ? v / 100 : v, z };
  const left = [cell(L.gross, '#,##0;-#,##0;"-"'), cell(L.sales, '#,##0;-#,##0;"-"'), cell(L.mfg, '#,##0;-#,##0;"-"'), cell(L.gp, '#,##0;-#,##0;"-"'), cell(Math.abs(L.op) < 0.5 ? 0 : L.op, '#,##0;-#,##0;"-"'), cell(L.labor, '0%', 1), cell(L.food, '0%', 1)].map(c => c && (Math.round(c.v) === c.v || c.z === '0%' ? c : { ...c, v: Math.round(c.v) }));
  const aoa = [[`${+S.ym.slice(5)}월 예상`, '목표', '목표', '실적', '전년']];
  SUB_KPI.forEach((d, i) => {
    const c = subCells(d.k), z = d.pct ? '0%' : d.xz;
    aoa.push([left[i] || null, cell(c.t, z, d.pct), cell(c.tt, z, d.pct), cell(c.a, z, d.pct), cell(c.p, z, d.pct)]);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '실적제출');
  XLSX.writeFile(wb, `로운_실적제출_${S.ym}.xlsx`);
}

function renderNotes(C) {
  const D = S.D, r = D.run;
  const pub = r.published_at ? new Date(r.published_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const est = [];
  for (const c of STORES) {
    const m = C.metas[c];
    if (m.costSrc.src !== 'own') est.push(`${sname(c)} 원가율(${m.costSrc.src === 'clone' ? sname(m.costSrc.of) + ' 동일' : m.costSrc.src === 'premium' ? '프리미엄 매장 평균' : '브랜드 평균'})`);
    if (m.mateSrc.src !== 'own') est.push(`${sname(c)} 메이트 급여율(${m.mateSrc.src === 'clone' ? sname(m.mateSrc.of) + ' 동일' : m.mateSrc.src === 'premium' ? '프리미엄 매장 평균' : '브랜드 평균'})`);
  }
  const noStaff = STORES.filter(c => C.metas[c].noStaff).map(sname);
  const li = [];
  li.push(`<b>외형매출·부가세</b> = 매출 앱 확정 예측 v${r.version}${pub ? ` (${pub} 발행)` : ''} — 폐점·신규 오픈 보정 반영. 매출액 = 외형매출 ÷ 1.1, 비율은 모두 매출액 대비.`);
  li.push(`<b>식재료원가</b> = ${D.costYm ? `${+D.costYm.slice(5)}월 누적 원가율(${D.costSpan ? D.costSpan.from.slice(5).replace('-', '/') + '~' + D.costSpan.to.slice(5).replace('-', '/') : ''}, 매장별 실적)` : '원가율 없음'} × 예상 매출액. <b>의제매입세액 공제</b> = 매출액의 −${(FOOD_TAX_PCT * 100).toFixed(1)}% (원본 손익표 기준 가정).`);
  li.push(`<b>급여_직원</b> = ${D.rYm ? `${+D.rYm.slice(5)}월 맨파워` : '8월 실측 구성'} × 직급 단가(+직책수당) + 연차수당(1인 ${(LC.LEAVE_PER_FT / 10000).toFixed(0)}만원)${noStaff.length ? ` · 맨파워 현황에 없는 매장은 정직원 0명: ${noStaff.join(', ')}` : ''}. <b>퇴직급여</b> = 정직원 1인 ${(LC.RETIRE_PER_FT / 10000).toFixed(0)}만원. 폐점 달은 영업 일수 비율로 줄이고, 신규 오픈 달은 정직원 한 달치를 잡습니다(오픈 전부터 근무).`);
  const mt = STORES.filter(c => C.metas[c].mate && C.metas[c].mate.how === 'mtd').length;
  li.push(`<b>급여_아르바이트</b> = 급여대장으로 확정된 누적 메이트 급여 + 남은 기간 예상 순매출 × 반영 비율(누적 비율과 ${+D.base.slice(5)}월 비율을 경과 일수/14로 섞음). 이번 달 급여대장이 있는 매장 ${mt}곳은 이 방식, 없는 매장은 ${+D.base.slice(5)}월 메이트 급여율 × 예상 순매출.`);
  if (D.est) {
    const E = D.est, mm = ym => `${ym.slice(2, 4)}년${+ym.slice(5)}월`;
    li.push(`<b>제조경비·판관비</b>는 전표 기준 직전 3개월(${E.base.map(mm).join('·')})로 추정합니다 — 복리후생·세금과공과: 급여 연동(직전 3개월 계정합 ÷ 급여합 × 예상 급여) · 소모품비: 매장별 '소모품비_매장집기' 최근 6개월 평균(그 외 소모품은 견본비(부자재)로 대체) · 감가상각·그 밖의 고정 계정: 직전 3개월 평균 × 영업일 비율 · 수도광열비: 직전 3개월 합계 평균(이력 없는 매장은 면적 × 단위면적당 평균) × 전년 계절 비율${E.seas && E.seas.n >= 3 ? ` ${E.seas.s.toFixed(2)}(${mm(E.seas.ly)}÷${E.seas.lyb.map(x => +x.slice(5)).join('·')}월 평균, 계속 영업한 ${E.seas.n}개 매장 — 여름 냉방분이 가을·겨울로 이어지지 않게)` : '(전년 전표가 부족해 보정 없음)'} · 운반비: 직전 3개월 비율 × 예상 순매출 · 기타제조경비(⑩): 기준표 합계(통신비·소각·청소·방역·리스·대행·유지보수) · 지급임차료: 임대을은 임차료율 × 순매출, 임대갑은 고정 · 광고선전비: 매장마다 5만원(추가분은 특이비용으로 입력) · 성과상여는 0 · 견본비는 두 줄 — 견본비(부자재): 부자재 사용량 비율(아래) / 견본비(사입): 매장별 '견본비_원부재료_국내' 최근 6개월 평균.`);
    li.push(`<b>안분비</b> = 법인 안분(EP 배부) ${mm(E.base[0])}~${mm(E.base[E.base.length - 1])} 평균 고정 금액 + 브랜드 안분 ${mm(E.brandYm)} 고정 금액 (+ 금융손익·진이익 차감). 안분 열의 금액은 각 계정 줄에서 볼 수 있습니다.`);
    const fbs = [...E.fb].map(([c, k]) => `${sname(c)}(${k} 평균)`); if (fbs.length) li.push(`전표 이력이 없거나 짧아 평균으로 대체한 매장: ${fbs.join(', ')} — 프리미엄 매장(동탄·의정부·해운대·광명·동부산·수지)은 프리미엄 매장 평균을 씁니다. 기타제조경비 기준표에 없는 매장(${STORES.filter(c => !E.fixed[c]).map(sname).join(', ') || '없음'})은 항목별 중앙값(프리미엄 매장은 프리미엄 매장 중앙값)을 썼습니다.`);
  } else li.push('<b>제조경비·판관비·안분비</b>: 전표가 아직 없어 비어 있습니다 (전표 업로드 후 채워집니다).');
  if (est.length) li.push(`이력이 없어 대체한 값: ${est.join(' · ')}`);
  li.push(`<b>당기순이익</b> = (영업이익 + 영업외손익 0 + 금융손익 −${((FIN_COST_EST - INT_INC_EST) / 1e6).toFixed(0)}백만원) × (1 − 법인세율 ${(TAX_RATE * 100).toFixed(0)}%), 세전이익이 음수면 세금 0. 26년6~9월 실적 영업이익에 적용하면 실제 순이익과 평균 오차 0.8백만원 (영업이익 65% 방식은 28백만원). <b>진이익</b> = 당기순이익 − ${(TRUE_NET_DED / 1e6).toFixed(0)}백만원 (브랜드 차감, 추정 — 브랜드 탭의 안분비 열에 들어감).`);
  const setSt = [...new Set(S.adj.filter(r => r.mode === 'set').map(r => r.scope))];
  if (setSt.length) li.push(`<b>고정값 매장</b>: ${setSt.map(sname).join(', ')} — 사용자가 직접 추정한 폐점·오픈 비용(손익 전체)을 그대로 씁니다. 매출만 예측이고 비용 계정은 아래 "특이비용" 목록의 고정값 줄입니다(삭제하면 규칙 계산으로 돌아갑니다).`);
  const fixAcc = S.adj.filter(r => r.mode === 'fix');
  if (fixAcc.length) li.push(`<b>계정 고정값</b>: ${fixAcc.map(r => `${sname(r.scope)} ${PNL_BY[r.account_code] ? PNL_BY[r.account_code].label.replace(/^[①-⑮]\s*/, '') : r.account_code} ${Math.round(+r.amount / 10000).toLocaleString('ko-KR')}만원`).join(' · ')} — 규칙 계산 대신 입력값을 씁니다(특이비용 목록의 고정값 줄, 삭제하면 규칙으로 복귀).`);
  li.push('매장 탭의 브랜드 안분비·법인 안분비 줄은 안분 합계를 매장 순매출 비율로 나눈 값입니다 (모든 매장이 매출 대비 같은 비율을 부담).');
  li.push(D.subYm ? `<b>견본비</b> = ${+D.subYm.slice(5)}월 부자재 사용액 ÷ 해당 기간 실매출${D.subSpan ? `(${D.subSpan.from.slice(5).replace('-', '/')}~${D.subSpan.to.slice(5).replace('-', '/')})` : ''} 비율(매장별, 업로드에 없는 매장은 프리미엄 매장은 프리미엄 평균·그 밖은 전 매장 합산 ${D.brandSubRate != null ? (D.brandSubRate * 100).toFixed(2) + '%' : '-'}) × 예상 순매출. 안분비의 견본비는 0입니다.${Object.keys(D.subRate).length ? '' : ' <span style="color:var(--crit)">부자재 사용량은 있지만 같은 기간 매출을 찾지 못해 비율을 계산하지 못했습니다 — 견본비가 0으로 들어갑니다.</span>'}${D.subSpan && D.subSpan.to < D.ym + '-15' && D.subYm === D.ym ? ' 월 초 며칠치 비율이라 변동이 큽니다(주차가 쌓일수록 안정).' : ''}` : '<b>견본비</b>: 부자재 사용량(원가 > 데이터 > 업로드 "자재 사용량(부자재)")이 아직 없어 0입니다 — 올리면 (부자재 사용액 ÷ 해당 기간 실매출) 비율 × 예상 순매출로 채워집니다.');
  { const sn = STORES.filter(c => (D.staff[c].snrPay || 0) > 0 && ftFrac(c, D.ym) > 0).map(sname);
    li.push(`<b>선임점장 급여 50% 본부 안분</b>: 선임점장(${sn.join('·') || '없음'}) 급여(단가+직책수당)의 ${SNR_HQ_SHARE * 100}%는 매장 급여_직원에서 빼고, 합계 ${Math.round(snrHqTotal() / 1e6 * 10) / 10}백만원을 브랜드 안분비의 급여_직원으로 넣었습니다(매장 탭에서는 브랜드 안분비 줄에 매출 비례로 나뉨). 연차수당·퇴직급여는 그대로 매장에 둡니다.`); }
  $('plNotes').innerHTML = '<ul>' + li.map(x => `<li>${x}</li>`).join('') + '</ul>';
}

// ---------- 특이비용 ----------
function pathLabel(a) { const p = []; for (let x = a; x; x = x.parent ? PNL_BY[x.parent] : null) p.unshift(x.label); return p.join(' › '); }
function fillAdjustAccounts() {
  const sc = $('adjScope');
  sc.innerHTML = `<option value="brand">브랜드(본부)</option>` + STORES.map(c => `<option value="${c}">${esc(sname(c))}</option>`).join('');
  $('adjAcc').innerHTML = PNL_ACC.filter(a => a.leaf && a.id !== 'true_ded').map(a => `<option value="${a.code}">${esc(pathLabel(a))}</option>`).join('');
}
function renderAdjust() {
  const rows = S.adj;
  const tot = rows.reduce((t, r) => t + (+r.amount || 0), 0);
  $('adjList').innerHTML = rows.length
    ? '<table class="pnl small"><thead><tr><th>범위</th><th>계정</th><th class="num">금액(원)</th><th>메모</th><th></th></tr></thead><tbody>' +
      rows.map(r => `<tr><td>${r.scope === 'brand' ? '브랜드(본부)' : esc(sname(r.scope))}</td><td>${esc(PNL_BY[r.account_code] ? pathLabel(PNL_BY[r.account_code]) : r.account_code)}</td><td class="num">${nf(r.amount)}</td><td>${esc(r.note || '')}${r.mode === 'set' ? ' <span class="pend">고정값(매장 전체)</span>' : r.mode === 'fix' ? ' <span class="pend">고정값(이 계정)</span>' : ''}</td><td><button class="btn btn-sm" data-del="${r.id}" type="button">삭제</button></td></tr>`).join('') +
      `<tr class="key"><td colspan="2">합계</td><td class="num">${nf(tot)}</td><td colspan="2"></td></tr></tbody></table>`
    : '<p class="dnote">이 달에 입력한 특이비용이 없습니다.</p>';
  document.querySelectorAll('#adjList [data-del]').forEach(b => { b.onclick = () => delAdjust(+b.dataset.del); });
}
async function addAdjust() {
  const amt = Number(String($('adjAmt').value).replace(/,/g, ''));
  const msg = $('adjMsg');
  if (!amt) { msg.textContent = '금액을 입력해 주세요.'; msg.style.color = 'var(--crit)'; return; }
  msg.textContent = '저장 중…'; msg.style.color = 'var(--muted)';
  const { error } = await sb.from('pnl_adjust').insert({ ym: S.ym, scope: $('adjScope').value, account_code: $('adjAcc').value, amount: amt, note: $('adjNote').value.trim() || null });
  if (error) { msg.textContent = '저장 실패: ' + error.message; msg.style.color = 'var(--crit)'; return; }
  $('adjAmt').value = ''; $('adjNote').value = '';
  msg.textContent = '추가했습니다 — 예상실적에 반영됨'; msg.style.color = 'var(--good)';
  S.adj = await loadAdjust(S.ym); renderAll();
}
async function delAdjust(id) {
  const { error } = await sb.from('pnl_adjust').delete().eq('id', id);
  if (error) { $('adjMsg').textContent = '삭제 실패: ' + error.message; return; }
  S.adj = await loadAdjust(S.ym); renderAll();
}

init();
