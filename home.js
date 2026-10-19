// 로운 홈 — 브랜드 점수판 (v2). 핵심 지표만: 매출(현재월 예상매출·동일매장 성장율) → 원가(현재월 누적 원가율) →
// 생산성(현재월 누적 인건비율·생산성) → 고객(최근 7일). 각 카드의 계산식은 해당 화면과 같다.
// ⚠ 복제본 주의: 매출 = sales.js renderBrand·sameStoreGrowth, 생산성 = ot.js otMtdRows·staffFor, 원가 = app.js loadCostTrend.
//   그쪽 계산을 바꾸면 여기도 같이 바꿀 것 (숫자가 화면마다 달라지지 않게).

const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const won = n => Math.round(n).toLocaleString('ko-KR');
const eok1 = n => (n / 1e8).toFixed(1) + '억';
const sgn = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);

// ---------- 날짜 헬퍼 ----------
const dObj = s => new Date(s + 'T00:00:00');
const dStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addD = (s, n) => { const d = dObj(s); d.setDate(d.getDate() + n); return dStr(d); };
const daysIn = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const monthDates = ym => Array.from({ length: daysIn(ym) }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };
const endExclusive = ym => `${shiftYm(ym, 1)}-01`;
const TODAY = dStr(new Date());
const CUR_YM = TODAY.slice(0, 7);

let isPlanner = false;

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
  isPlanner = role === 'planner';
  $('roleChip').textContent = isPlanner ? '기획자' : '매장 관리자';
  renderCards();
}
$('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.replace('../'); };

// ---------- 카드 공통 ----------
const metric = (label, value, sub, color) => `<div class="m"><div class="ml">${label}</div><div class="mv" style="${color ? 'color:' + color : ''}">${value}</div><div class="ms">${sub || ''}</div></div>`;
const card = (href, title, sub, body, foot) => `<a class="hcard" href="${href}"><div class="t">${title}<span>${sub}</span></div><div class="mrow">${body}</div><div class="f">${foot}</div></a>`;
const pending = (href, title, sub) => card(href, title, sub, '<div class="m"><div class="mv" style="color:var(--muted2);font-size:18px">불러오는 중…</div></div>', '');
const failed = (href, title, sub, e) => card(href, title, sub, '<div class="m"><div class="mv" style="color:var(--crit);font-size:16px">불러오기 실패</div></div>', esc(e && e.message || e));
const noData = (href, title, sub, msg) => card(href, title, sub, `<div class="m"><div class="mv" style="color:var(--muted2);font-size:18px">자료 없음</div></div>`, msg);
function setCard(k, html) { const e = $('hc-' + k); if (e) e.innerHTML = html; }

function renderCards() {
  const defs = [
    ['sales', '../sales/', '매출', '현재월'],
    ['cost', '../cost/', '원가', '현재월 누적'],
    ['labor', '../labor/', '생산성', '현재월 누적'],
    ['voc', '../voc/', '고객', '최근 7일 리뷰']
  ];
  $('homeCards').innerHTML = defs.map(([k, h, t, s]) => `<div id="hc-${k}" style="display:contents">${pending(h, t, s)}</div>`).join('');
  fillSales().catch(e => setCard('sales', failed('../sales/', '매출', '현재월', e)));
  fillCost().catch(e => setCard('cost', failed('../cost/', '원가', '현재월 누적', e)));
  fillLabor().catch(e => setCard('labor', failed('../labor/', '생산성', '현재월 누적', e)));
  fillVoc().catch(e => setCard('voc', failed('../voc/', '고객', '최근 7일 리뷰', e)));
}

async function fetchRows(build, pageSize = 1000) {
  const acc = [];
  for (let i = 0; ; i++) {
    const { data, error } = await build().range(i * pageSize, i * pageSize + pageSize - 1);
    if (error) throw error;
    acc.push(...data);
    if (data.length < pageSize) break;
  }
  return acc;
}

// ================= 매출: 현재월 예상매출 · 동일매장 성장율 (sales.js renderBrand와 같은 계산) =================
const SF_PAST_HOLIDAYS = new Set(['2025-08-15', '2025-10-03', '2025-10-05', '2025-10-06', '2025-10-07',
  '2025-10-08', '2025-10-09', '2025-12-25', '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18',
  '2026-03-01', '2026-03-02', '2026-05-05', '2026-05-24', '2026-05-25', '2026-06-06', '2026-08-15', '2026-08-17']);
const isHolCmp = d => OT_HOLIDAYS.has(d) || SF_PAST_HOLIDAYS.has(d);

async function fillSales() {
  const { data: runs, error } = await sb.from('sf_forecast_runs').select('ym,version,kind,daily').eq('kind', '확정').order('ym', { ascending: false }).order('version', { ascending: false });
  if (error) throw error;
  if (!runs || !runs.length) { setCard('sales', noData('../sales/', '매출', '현재월', '발행된 확정 예측이 없습니다.')); return; }
  const run = runs.find(r => r.ym === CUR_YM) || runs[0];
  const ym = run.ym, dates = monthDates(ym);
  const py0 = addD(ym + '-01', -364);
  const [cur, prev] = await Promise.all([
    fetchRows(() => sb.from('ot_sales_daily').select('store_code,sales_date,total').gte('sales_date', ym + '-01').lt('sales_date', endExclusive(ym)).order('sales_date').order('store_code')),
    fetchRows(() => sb.from('ot_sales_daily').select('store_code,sales_date,total').gte('sales_date', py0).lt('sales_date', addD(endExclusive(ym), -364)).order('sales_date').order('store_code'))
  ]);
  const S = {};
  for (const r of [...cur, ...prev]) (S[r.store_code] || (S[r.store_code] = new Map())).set(r.sales_date, Number(r.total));
  let asOf = null;
  for (const r of cur) if (!asOf || r.sales_date > asOf) asOf = r.sales_date;
  let fcT = 0, landT = 0;
  for (const [code, f] of Object.entries(run.daily.stores)) {
    const m = S[code] || new Map();
    fcT += f.total;
    for (const d of dates) landT += (asOf && d <= asOf) ? (m.get(d) || 0) : (f.daily[d] || 0);
  }
  // 동일매장 성장율: 전년 -364일(같은 요일), 양쪽 모두 영업 실적이 있는 날짜쌍만, 어느 한쪽이 공휴일이면 제외
  let cs = 0, ps = 0, n = 0;
  if (asOf) {
    for (const code of Object.keys(OT_DATA)) {
      const m = S[code]; if (!m) continue;
      let c = 0, p = 0;
      for (let d = ym + '-01'; d <= asOf; d = addD(d, 1)) {
        const pd = addD(d, -364);
        if (isHolCmp(d) || isHolCmp(pd)) continue;
        const cv = m.get(d), pv = m.get(pd);
        if (cv > 0 && pv > 0) { c += cv; p += pv; }
      }
      if (c > 0 && p > 0) { cs += c; ps += p; n++; }
    }
  }
  const ssg = ps ? (cs / ps - 1) * 100 : null;
  const vs = fcT ? (landT / fcT - 1) * 100 : 0;
  const gcol = g => g < 0 ? 'var(--crit)' : g < 5 ? 'var(--warn)' : 'var(--good)';
  const body = metric('현재 예상 매출', eok1(landT), `월초 예측 대비 <b style="color:${vs >= 0 ? 'var(--good)' : 'var(--crit)'}">${sgn(vs)}%</b>`)
    + metric('동일매장 성장율', ssg == null ? '—' : sgn(ssg) + '%', ssg == null ? '실적 대기' : `전년 동기간 대비 · ${n}개점`, ssg == null ? '' : gcol(ssg));
  setCard('sales', card('../sales/?v=brand', '매출', `${+ym.slice(5)}월` + (asOf ? ` · 실적 ~${asOf.slice(5).replace('-', '/')}` : ''), body, '현재 예상 = 지난 날은 실적 + 남은 날은 확정 예측 · 성장율은 요일 맞춤·공휴일 제외'));
}

// ================= 원가: 현재월 누적 원가율 (app.js loadCostTrend와 같은 식: 자재 실사용액 ÷ 순매출(외형÷1.1)) =================
async function fillCost() {
  const { data: tot, error } = await sb.rpc('material_usage_monthly_totals');
  if (error) throw error;
  const costBy = {};
  (tot || []).forEach(r => { const m = (r.usage_month || '').slice(0, 7); if (m) costBy[m] = (costBy[m] || 0) + (Number(r.total_amount) || 0); });
  const months = Object.keys(costBy).filter(m => m <= CUR_YM).sort();
  if (!months.length) { setCard('cost', noData('../cost/', '원가', '현재월 누적', '자재 사용량 데이터가 없습니다.')); return; }
  const ym = months[months.length - 1];
  const um = ym + '-01';
  const [a, b] = await Promise.all([
    sb.from('material_usage').select('period_start').eq('usage_month', um).order('period_start', { ascending: true }).limit(1),
    sb.from('material_usage').select('period_end').eq('usage_month', um).order('period_end', { ascending: false }).limit(1)
  ]);
  const from = a.data && a.data[0] && a.data[0].period_start, to = b.data && b.data[0] && b.data[0].period_end;
  if (!from || !to) { setCard('cost', noData('../cost/', '원가', '현재월 누적', '주차 정보를 찾지 못했습니다.')); return; }
  const pym = shiftYm(ym, -1);
  const [sales, psales] = await Promise.all([
    fetchRows(() => sb.from('store_sales').select('sales_total').gte('sales_date', from).lte('sales_date', to).order('id')),
    fetchRows(() => sb.from('store_sales').select('sales_total').gte('sales_date', pym + '-01').lt('sales_date', ym + '-01').order('id'))
  ]);
  const net = sales.reduce((t, r) => t + (Number(r.sales_total) || 0), 0) / 1.1;
  if (!net) { setCard('cost', noData('../cost/', '원가', '현재월 누적', '해당 기간 매출이 없습니다.')); return; }
  const ratio = costBy[ym] / net * 100;
  const pnet = psales.reduce((t, r) => t + (Number(r.sales_total) || 0), 0) / 1.1;
  const pratio = pnet && costBy[pym] ? costBy[pym] / pnet * 100 : null;
  const d = pratio == null ? null : ratio - pratio;
  const body = metric('누적 원가율', ratio.toFixed(1) + '%', `${from.slice(5).replace('-', '/')}~${to.slice(5).replace('-', '/')} 마감 주차 기준`)
    + metric('전월 원가율', pratio == null ? '—' : pratio.toFixed(1) + '%', d == null ? '' : `이번 달 <b style="color:${d > 0 ? 'var(--crit)' : 'var(--good)'}">${sgn(d)}%p</b>`);
  setCard('cost', card('../cost/?v=pivot', '원가', `${+ym.slice(5)}월 누적`, body, ''));
}

// ================= 생산성: 현재월 누적 인건비율 · 생산성 (ot.js otMtdRows와 같은 계산) =================
const GRADE_ORDER = ['선임점장', '점장', '부점장', 'GM', '매니저', '캡틴', '헤드', 'ST', 'TM', 'HIT'];
async function fillLabor() {
  const [a, b] = await Promise.all([
    sb.from('ot_sales_daily').select('sales_date').order('sales_date', { ascending: false }).limit(1),
    sb.from('ot_labor_daily').select('work_date').order('work_date', { ascending: false }).limit(1)
  ]);
  const ls = a.data && a.data[0] && a.data[0].sales_date, ll = b.data && b.data[0] && b.data[0].work_date;
  if (!ls || !ll) { setCard('labor', noData('../labor/', '생산성', '현재월 누적', '매출·근태 실적이 없습니다.')); return; }
  const ym = (ls < ll ? ls : ll).slice(0, 7);
  const [sr, lr, perRows, rosterRows, gradeRes] = await Promise.all([
    fetchRows(() => sb.from('ot_sales_daily').select('store_code,sales_date,total,is_closed').gte('sales_date', ym + '-01').lt('sales_date', endExclusive(ym)).order('sales_date').order('store_code')),
    fetchRows(() => sb.from('ot_labor_daily').select('store_code,work_date,mate_mh,ft_mh').gte('work_date', ym + '-01').lt('work_date', endExclusive(ym)).order('work_date').order('store_code')),
    fetchRows(() => sb.from('ot_labor_periods').select('store_code,period_start,period_end,mate_pay,mate_mh').gte('period_start', ym + '-01').lt('period_start', endExclusive(ym)).order('period_start').order('store_code')),
    fetchRows(() => sb.from('ot_staff_roster').select('ym,store_code,grade,headcount').order('ym').order('store_code').order('grade')).catch(() => []),
    isPlanner ? sb.from('ot_grades').select('grade,std_monthly_cost,allowance') : Promise.resolve({ data: null })
  ]);
  // 정직원 구성·급여 — ot.js staffFor/calcStaffPay와 같은 규칙 (맨파워가 있으면 그것, 없으면 8월 실측 시드)
  const ROSTER = {};
  for (const r of rosterRows) { const byStore = (ROSTER[r.ym] = ROSTER[r.ym] || {}); (byStore[r.store_code] = byStore[r.store_code] || {})[r.grade] = r.headcount; }
  let gradeCost = null, gradeAllow = null;
  if (gradeRes.data && gradeRes.data.length) { gradeCost = {}; gradeAllow = {}; for (const g of gradeRes.data) { gradeCost[g.grade] = g.std_monthly_cost; gradeAllow[g.grade] = g.allowance || 0; } }
  const staffFor = code => {
    const s0 = OT_DATA[code];
    const k = Object.keys(ROSTER).filter(m => m <= ym && ROSTER[m][code]).sort().pop();
    if (!k) return { nfull: s0.nfull, fullpay: s0.fullpay };
    const counts = ROSTER[k][code];
    const nf = GRADE_ORDER.reduce((t, g) => t + (counts[g] || 0), 0);
    let fullpay;
    if (gradeCost) {
      const allow = g => (gradeAllow && gradeAllow[g]) || 0;
      const base = GRADE_ORDER.reduce((t, g) => t + (counts[g] || 0) * ((gradeCost[g] || 0) + allow(g)), 0);
      const seed = OT_STAFF0[code] || {};
      const seedAllow = GRADE_ORDER.reduce((t, g) => t + (seed[g] || 0) * allow(g), 0);
      fullpay = Math.max(0, base + (s0.payOff || 0) - seedAllow);
    } else {
      const avg = s0.fullpay / s0.nfull;
      fullpay = Math.max(0, s0.fullpay + (Math.max(1, nf) - s0.nfull) * avg);
    }
    return { nfull: Math.max(1, nf), fullpay };
  };
  const sBy = {}, lBy = {};
  sr.forEach(r => { (sBy[r.store_code] = sBy[r.store_code] || {})[r.sales_date] = r; });
  lr.forEach(r => { (lBy[r.store_code] = lBy[r.store_code] || {})[r.work_date] = r; });
  const pBy = {};
  perRows.forEach(r => { (pBy[r.store_code] = pBy[r.store_code] || []).push(r); });
  const dim = daysIn(ym);
  let tSales = 0, tMH = 0, tLabor = 0, tRatioSales = 0, n = 0, nEst = 0, first = null, last = null, rCut = '';
  for (const [code, s0] of Object.entries(OT_DATA)) {
    const S = sBy[code], L = lBy[code];
    if (!S || !L) continue;
    let sales = 0, mate = 0, ft = 0, days = 0, sFirst = null, sLast = null;
    const dayRows = [];
    for (const iso of monthDates(ym)) {
      const x = S[iso], y = L[iso];
      if (!x || !y || x.is_closed || !(+x.total > 0)) continue;
      sales += +x.total; mate += +y.mate_mh || 0; ft += +y.ft_mh || 0; days++;
      dayRows.push({ iso, mate_mh: +y.mate_mh || 0, sales: +x.total });
      if (!sFirst) sFirst = iso;
      sLast = iso;
    }
    if (!days) continue;
    const attByDate = {};
    for (const iso of Object.keys(L)) attByDate[iso] = +L[iso].mate_mh || 0;
    const lc = lcStoreCost({ dim, eff: s0.eff, staff: staffFor(code), dayRows, attByDate, periods: pBy[code] });
    tLabor += lc.labor;                 // 급여 등록일까지의 인건비
    tRatioSales += lc.ratioSales;       // 같은 날짜까지의 매출 (인건비율용)
    if (lc.cutIso > rCut) rCut = lc.cutIso;
    if (!lc.hasPay || lc.estDays > 0) nEst++;
    tSales += sales; tMH += mate + ft; n++;
    if (!first || sFirst < first) first = sFirst;
    if (!last || sLast > last) last = sLast;
  }
  if (!n) { setCard('labor', noData('../labor/', '생산성', '현재월 누적', '이 달에 적재된 실적이 없습니다.')); return; }
  tLabor += lcHqCost(dim, rCut);   // 본부 인건비(월 6,500만원)를 기준일÷월일수로 환산 — 전사 합계에만
  const ratio = tLabor / (tRatioSales / 1.1) * 100, prod = tSales / tMH;
  const rcol = ratio <= 24 ? 'var(--good)' : ratio <= 28 ? 'var(--warn)' : 'var(--crit)';
  const pcol = prod >= 72000 ? 'var(--good)' : prod >= 60000 ? 'var(--warn)' : 'var(--crit)';
  const body = metric('누적 인건비율', ratio.toFixed(1) + '%', `${first.slice(5).replace('-', '/')}~${rCut.slice(5).replace('-', '/')} 급여 등록일까지 · 본부 포함`, rcol)
    + metric('누적 생산성', won(prod) + '<span class="mu">원/MH</span>', `${first.slice(5).replace('-', '/')}~${last.slice(5).replace('-', '/')} · 목표 72,000 대비 ${(prod / 72000 * 100).toFixed(0)}%`, pcol);
  setCard('labor', card('../labor/?v=dash', '생산성', `${+ym.slice(5)}월 누적 · ${n}개점`, body, nEst ? `<span style="color:var(--crit)">급여대장 대신 추정으로 계산한 매장 ${nEst}곳 — 급여대장 업로드 확인 필요</span>` : ''));
}

// ================= 고객: 최근 7일 리뷰 =================
const sig = (r, y, g) => `<div class="m"><div class="sg"><span class="r"><i></i>${r}</span><span class="y"><i></i>${y}</span><span class="g"><i></i>${g}</span></div></div>`;
async function fillVoc() {
  const { data: last, error } = await sb.from('cx_reviews').select('sale_date').order('sale_date', { ascending: false }).limit(1);
  if (error) throw error;
  if (!last || !last.length) { setCard('voc', noData('../voc/', '고객', '최근 7일 리뷰', '리뷰 데이터가 없습니다.')); return; }
  const end = last[0].sale_date, start = addD(end, -6);
  const rows = await fetchRows(() => sb.from('cx_reviews').select('id,rating,red_flag,categories').gte('sale_date', start).lte('sale_date', end).order('id'));
  const red = rows.filter(r => r.red_flag);
  const neg = rows.filter(r => !r.red_flag && (r.rating <= 3 || (r.categories && r.categories.length)));
  const ok = rows.length - red.length - neg.length;
  let open = red.length;
  if (red.length) {
    const { data: acts } = await sb.from('cx_actions').select('review_id,status').in('review_id', red.map(r => r.id));
    const done = new Set((acts || []).filter(a => a.status === '완료').map(a => a.review_id));
    open = red.filter(r => !done.has(r.id)).length;
  }
  setCard('voc', card('../voc/?v=' + (open ? 'red' : 'brand'), '고객', `${start.slice(5)} ~ ${end.slice(5)} · 리뷰 ${rows.length}건`, sig(red.length, neg.length, ok), `🔴 레드플래그(미조치 ${open}건) · 🟠 그 외 불만(평점 3 이하·부정 요인) · 🟢 정상`));
}

init();
