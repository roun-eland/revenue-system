// 로운 매출 — SF-M1: 분해 모델 v1(sfv1) + 브랜드 대시보드(V1) + 매장 일별(V2) + 발행 관리(V4)
// 예측(매장,일) = BASE(요일 중앙값) × SR(계절비) × H(공휴일) × T(추세) — 매출예측 PRD v1.0
// 확정 예측은 컷오프(전월 말)까지의 실적만 사용해 sf_forecast_runs에 불변 스냅샷으로 발행.

// ---------- Supabase (통합 프로젝트) ----------
const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = id => document.getElementById(id);
const won = n => Math.round(n).toLocaleString('ko-KR');
const eok = n => (n / 1e8).toFixed(2) + '억';
const man = n => won(n / 1e4) + '만';

// ---------- 모델 상수 ----------
const MODEL_VERSION = 'sfv1';
const P199 = new Set(['RU030', 'RU031', 'RU033', 'RU035', 'RU037', 'RU039', 'RU041']);
const PREMIER = new Set(['RU042', 'RU043', 'RU044', 'RU045', 'RU046']);
const PMODEL = code => P199.has(code) ? '199' : PREMIER.has(code) ? '프리미어' : '일반';
const P199_FROM = '2025-09-01';           // 199 가격모델 전환 — 이전 데이터는 예측에 미사용
const NEW_OPEN = { RU046: '2026-09-18' }; // 신규점 오픈일 — 실적 쌓일 때까지 가정치 모델
const WD = ['월', '화', '수', '목', '금', '토', '일'];

// ---------- 날짜 헬퍼 (문자열 기반, 로컬 자정 고정) ----------
const dObj = s => new Date(s + 'T00:00:00');
const dStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addD = (s, n) => { const d = dObj(s); d.setDate(d.getDate() + n); return dStr(d); };
const dowIdx = s => (dObj(s).getDay() + 6) % 7; // 0=월 … 6=일 (OT_DATA.wd 순서와 동일)
const daysIn = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const monthDates = ym => Array.from({ length: daysIn(ym) }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };
const cutoffOf = ym => addD(ym + '-01', -1); // 전월 말일
const ymLabel = ym => `${ym.slice(0, 4)}년 ${+ym.slice(5)}월`;
const nthOfDow = s => Math.ceil(+s.slice(8) / 7); // 그 달의 몇 번째 해당 요일인지
const isHol = s => OT_HOLIDAYS.has(s);
function isClosed(code, s) {
  // 유통점 공지 확정치가 있는 달은 그 날짜만 휴점 (규칙·전점휴무 무시 — 예: 해운대 2026-09-25 영업)
  const ov = OT_CLOSED_ACTUAL[s.slice(0, 7)] && OT_CLOSED_ACTUAL[s.slice(0, 7)][code];
  if (ov) return ov.includes(+s.slice(8));
  if (OT_CLOSED_DATES.has(s)) return true; // 명절 당일 전 매장 휴무
  const c = OT_DATA[code].closed;
  return !!(c && dowIdx(s) === c.wd && c.nth.includes(nthOfDow(s)));
}

// ---------- 데이터 로드 ----------
let SALES = {};   // store_code -> Map(sales_date -> total)  ※ 0원(휴점)은 행 없음
let RUNS = [];    // sf_forecast_runs

async function loadSales() {
  const acc = {};
  for (let i = 0; ; i++) {
    const { data, error } = await sb.from('ot_sales_daily')
      .select('store_code,sales_date,total')
      .order('sales_date').order('store_code')
      .range(i * 1000, i * 1000 + 999);
    if (error) throw error;
    for (const r of data) (acc[r.store_code] || (acc[r.store_code] = new Map())).set(r.sales_date, r.total);
    if (data.length < 1000) break;
  }
  SALES = acc;
}
async function loadRuns() {
  const { data, error } = await sb.from('sf_forecast_runs')
    .select('id,ym,version,kind,model_version,cutoff_date,published_at,daily,note')
    .order('ym', { ascending: false }).order('version', { ascending: false });
  if (error) throw error;
  RUNS = data || [];
}
function getRun(ym) { return RUNS.find(r => r.ym === ym && r.kind === '확정') || null; } // 정렬상 최신 버전이 먼저

// ---------- 분해 모델 sfv1 ----------
const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const avg = a => a.reduce((t, x) => t + x, 0) / a.length;

// BASE: 컷오프 이전 최근 4회 같은 요일 실적의 중앙값 (공휴일·휴점 제외, 최대 12주 소급)
function baseFor(code, cutoff) {
  const m = SALES[code] || new Map();
  const min = P199.has(code) ? P199_FROM : '0000';
  const base = Array(7).fill(null);
  for (let idx = 0; idx < 7; idx++) {
    const vals = [];
    let d = addD(cutoff, -((dowIdx(cutoff) - idx + 7) % 7)); // 컷오프 이하 첫 해당 요일
    for (let k = 0; k < 12 && vals.length < 4; k++, d = addD(d, -7)) {
      if (d < min) break;
      if (isHol(d)) continue;
      const v = m.get(d);
      if (v > 0) vals.push(v);
    }
    if (vals.length) base[idx] = median(vals);
  }
  return base;
}

// 월 일평균 (영업일 기준) — SR 계산용
function monthDailyMean(code, ym) {
  const m = SALES[code] || new Map();
  let sum = 0, n = 0;
  for (const d of monthDates(ym)) { const v = m.get(d); if (v > 0) { sum += v; n++; } }
  return { mean: n ? sum / n : 0, n };
}

// SR: 대상월/전월 일평균 비율을 과거 2개년에서 평균. 폴백 ①자체 → ②가격모델군 → ③전사
// 199 매장은 전환(2025-09) 이후 완결 쌍만 자체 계수로 인정.
function srTable(ym) {
  const own = {};
  for (const code of Object.keys(OT_DATA)) {
    if (NEW_OPEN[code]) continue;
    const pairs = [];
    for (const off of [-12, -24]) {
      const tYm = shiftYm(ym, off), pYm = shiftYm(tYm, -1);
      if (P199.has(code) && pYm + '-01' < P199_FROM) continue;
      const a = monthDailyMean(code, tYm), b = monthDailyMean(code, pYm);
      // 오픈 램프 가드: 쌍의 전전월도 정상 영업(≥20일)이어야 계절비로 인정
      // (오픈 직후 특수 소멸을 계절성으로 오인하는 것 방지 — 예: 동탄 2025-08 오픈빨)
      const pre = monthDailyMean(code, shiftYm(pYm, -1));
      if (a.n >= 20 && b.n >= 20 && pre.n >= 20) pairs.push(a.mean / b.mean);
    }
    own[code] = pairs.length ? avg(pairs) : null;
  }
  const valid = Object.entries(own).filter(([, v]) => v !== null);
  const companySR = valid.length ? avg(valid.map(([, v]) => v)) : 1;
  const groupSR = {};
  for (const g of ['일반', '199', '프리미어']) {
    const vs = valid.filter(([c]) => PMODEL(c) === g).map(([, v]) => v);
    groupSR[g] = vs.length ? avg(vs) : null;
  }
  return code => own[code] !== null && own[code] !== undefined
    ? { v: own[code], src: '자체' }
    : groupSR[PMODEL(code)] !== null ? { v: groupSR[PMODEL(code)], src: '모델군' } : { v: companySR, src: '전사' };
}

// T: 최근 4주 ÷ 이전 4주 (컷오프 기준), [0.9, 1.1] 클립
function trendFor(code, cutoff) {
  const m = SALES[code] || new Map();
  if (P199.has(code) && addD(cutoff, -55) < P199_FROM) return 1;
  let s1 = 0, s2 = 0;
  for (let k = 0; k < 28; k++) { s1 += m.get(addD(cutoff, -k)) || 0; s2 += m.get(addD(cutoff, -28 - k)) || 0; }
  if (!s2) return 1;
  return Math.min(1.1, Math.max(0.9, s1 / s2));
}

// 전체 예측 산출 — sf_forecast_runs.daily에 그대로 저장되는 스냅샷
function computeForecast(ym, cutoff) {
  const sr = srTable(ym);
  const stores = {};
  for (const code of Object.keys(OT_DATA)) {
    const s = OT_DATA[code], daily = {};
    let meta;
    if (NEW_OPEN[code]) {
      // 신규점: 목표 월매출(augM)/30.4 × 요일 분포(프리미어 평균 계수) 가정치
      const perDay = s.augM / 30.4;
      for (const d of monthDates(ym)) {
        daily[d] = (d < NEW_OPEN[code] || isClosed(code, d)) ? 0
          : Math.round(perDay * (isHol(d) ? s.hol : s.wd[dowIdx(d)]) / 1000) * 1000;
      }
      meta = { sr: null, trend: null, src: '신규 가정치', open_from: NEW_OPEN[code] };
    } else {
      const base = baseFor(code, cutoff);
      const present = base.filter(v => v !== null);
      const baseMean = present.length ? avg(present) : 0;
      const { v: srv, src } = sr(code);
      const t = trendFor(code, cutoff);
      for (const d of monthDates(ym)) {
        if (isClosed(code, d)) { daily[d] = 0; continue; }
        const idx = dowIdx(d);
        // 평일 공휴일 = 요일 정체성 상실 → 평균×공휴일지수. 주말 공휴일 = 요일 유지.
        const b = (isHol(d) && idx < 5) ? baseMean * s.hol : (base[idx] !== null ? base[idx] : baseMean);
        daily[d] = Math.round(b * srv * t / 1000) * 1000;
      }
      meta = { sr: +srv.toFixed(4), trend: +t.toFixed(4), src };
    }
    const total = Object.values(daily).reduce((t, v) => t + v, 0);
    stores[code] = { name: s.name, total, ...meta, daily };
  }
  return { model_version: MODEL_VERSION, ym, cutoff_date: cutoff, stores };
}

// ---------- 인증 (생산성과 동일 — 로그인은 랜딩에서) ----------
let currentUser = null, currentRole = 'planner', isPlanner = false;

async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) enterApp(session.user); else location.replace('../');
}
async function enterApp(user) {
  currentUser = user;
  $('loginView').hidden = true; $('appView').hidden = false;
  $('whoEmail').textContent = user.email;
  try {
    const { data } = await sb.from('ot_profiles').select('role').eq('user_id', user.id).maybeSingle();
    if (data && data.role) currentRole = data.role;
  } catch (e) { /* 무시 */ }
  isPlanner = currentRole === 'planner';
  $('roleChip').textContent = isPlanner ? '기획자' : '매장 관리자';
  document.querySelector('#sfNav button[data-view="admin"]').hidden = !isPlanner;

  try {
    await Promise.all([loadSales(), loadRuns()]);
  } catch (e) {
    $('brandKpis').innerHTML = `<div style="grid-column:1/-1;color:var(--crit)">데이터 로드 실패: ${e.message}</div>`;
    return;
  }
  buildSelectors();
  renderBrand();
  renderDaily();
  if (isPlanner) renderRuns();
  showView('brand');
}
$('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.replace('../'); };

function showView(v) {
  document.querySelectorAll('#sfNav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  for (const k of ['brand', 'daily', 'acc', 'admin']) $('view-' + k).hidden = (k !== v);
}
document.querySelectorAll('#sfNav button').forEach(b => { if (!b.disabled) b.onclick = () => showView(b.dataset.view); });

// ---------- 셀렉터 ----------
function buildSelectors() {
  const runYms = [...new Set(RUNS.filter(r => r.kind === '확정').map(r => r.ym))].sort().reverse();
  const yms = runYms.length ? runYms : ['2026-09'];
  for (const id of ['brandMonth', 'dailyMonth']) {
    const sel = $(id), keep = sel.value;
    sel.innerHTML = '';
    for (const ym of yms) {
      const o = document.createElement('option');
      o.value = ym; o.textContent = ymLabel(ym) + (getRun(ym) ? '' : ' (미발행)');
      sel.appendChild(o);
    }
    if (yms.includes(keep)) sel.value = keep;
  }
  const ss = $('dailyStore');
  if (!ss.options.length) {
    const codes = Object.keys(OT_DATA).sort(); // 매장코드 순
    for (const c of codes) {
      const o = document.createElement('option');
      o.value = c; o.textContent = `${OT_DATA[c].name} (${c})`;
      ss.appendChild(o);
    }
  }
  const ps = $('pubMonth');
  if (isPlanner && !ps.options.length) {
    for (const ym of ['2026-09', '2026-10']) {
      const o = document.createElement('option');
      o.value = ym; o.textContent = `${ymLabel(ym)} (컷오프 ${cutoffOf(ym)})`;
      ps.appendChild(o);
    }
  }
  $('brandMonth').onchange = renderBrand;
  $('dailyMonth').onchange = renderDaily;
  $('dailyStore').onchange = renderDaily;
  $('toPlanBtn').href = '../labor/';
}

// 해당 월 실적이 있는 마지막 일자 (브랜드 공통 기준일)
function lastActualDate(ym) {
  let last = null;
  for (const code of Object.keys(OT_DATA)) {
    const m = SALES[code]; if (!m) continue;
    for (const d of m.keys()) if (d.startsWith(ym) && (!last || d > last)) last = d;
  }
  return last;
}

// ---------- V1 브랜드 대시보드 ----------
let brandChartObj = null;
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const eok1 = n => (n / 1e8).toFixed(1) + '억';

// 동일매장 성장율용 공휴일 판정 — 전년 비교 기간에 걸리는 과거 공휴일 포함(모델 산출에는 사용 안 함)
const SF_PAST_HOLIDAYS = new Set(['2025-08-15', '2025-10-03', '2025-10-05', '2025-10-06', '2025-10-07',
  '2025-10-08', '2025-10-09', '2025-12-25', '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18',
  '2026-03-01', '2026-03-02', '2026-05-05', '2026-05-24', '2026-05-25', '2026-06-06', '2026-08-15', '2026-08-17']);
const isHolCmp = d => OT_HOLIDAYS.has(d) || SF_PAST_HOLIDAYS.has(d);

// 동일매장 성장율: 전년 비교 기간은 -364일(같은 요일), 양쪽 모두 영업 실적이 있는 날짜쌍만 사용,
// 어느 한쪽이라도 공휴일이면 그 쌍은 제외. 두 기간 모두 실적이 있는 매장(동일매장)만 합산.
function sameStoreGrowth(ym, asOf) {
  if (!asOf) return null;
  let cur = 0, prv = 0, nStores = 0;
  for (const code of Object.keys(OT_DATA)) {
    const m = SALES[code]; if (!m) continue;
    let c = 0, p = 0;
    for (let d = ym + '-01'; d <= asOf; d = addD(d, 1)) {
      const pd = addD(d, -364);
      if (isHolCmp(d) || isHolCmp(pd)) continue;
      const cv = m.get(d), pv = m.get(pd);
      if (cv > 0 && pv > 0) { c += cv; p += pv; }
    }
    if (c > 0 && p > 0) { cur += c; prv += p; nStores++; }
  }
  return prv ? { g: (cur / prv - 1) * 100, n: nStores, from: addD(ym + '-01', -364), to: addD(asOf, -364) } : null;
}

function renderBrand() {
  const ym = $('brandMonth').value;
  const run = getRun(ym);
  if (!run) {
    $('brandKpis').innerHTML = '';
    $('brandTable').innerHTML = `<div class="placeholder-box"><b>${ymLabel(ym)} 확정 예측이 아직 발행되지 않았습니다.</b><br>발행 관리에서 확정 예측을 발행하면 여기에 표시됩니다.</div>`;
    if (brandChartObj) { brandChartObj.destroy(); brandChartObj = null; }
    return;
  }
  const st = run.daily.stores, dates = monthDates(ym);
  const asOf = lastActualDate(ym);
  const prevYearYm = shiftYm(ym, -12);

  const rows = Object.entries(st).map(([code, f]) => {
    const m = SALES[code] || new Map();
    let act = 0, fcToAsOf = 0, landing = 0, py = 0;
    for (const d of dates) {
      const fv = f.daily[d] || 0;
      if (asOf && d <= asOf) { act += m.get(d) || 0; fcToAsOf += fv; landing += m.get(d) || 0; }
      else landing += fv;
    }
    for (const d of monthDates(prevYearYm)) py += (m.get(d) || 0);
    return { code, name: f.name, fc: f.total, act, fcToAsOf, landing, py, src: f.src, sr: f.sr, trend: f.trend };
  }).sort((a, b) => (a.code < b.code ? -1 : 1)); // 매장코드 순

  const sum = k => rows.reduce((t, r) => t + r[k], 0);
  const fcT = sum('fc'), actT = sum('act'), fcAsT = sum('fcToAsOf'), landT = sum('landing'), pyT = sum('py');
  const paceT = fcAsT ? actT / fcAsT * 100 : null;
  const yoyT = pyT ? (landT / pyT - 1) * 100 : null;

  $('brandSub').textContent = `${ymLabel(ym)} 확정 v${run.version} · 모델 ${run.model_version} · 컷오프 ${run.cutoff_date} · 발행 ${String(run.published_at).slice(0, 10)}` +
    (asOf ? ` · 실적 반영 ~${asOf.slice(5).replace('-', '/')}` : ' · 이 달 실적 미적재 (생산성 > 실적 입력에서 일별매출 업로드 시 자동 반영)');

  const ssg = sameStoreGrowth(ym, asOf);
  $('brandKpis').innerHTML = `
    <div><div class="k">월초 예상 매출</div><div class="v">${eok1(fcT)}</div><div class="s">18개 매장 · 확정 v${run.version}</div></div>
    <div><div class="k">현재 예상 매출</div><div class="v">${eok1(landT)}</div><div class="s">예측 대비 ${fcT ? ((landT / fcT - 1) * 100).toFixed(1) : '0.0'}% · 누적 매출 ${asOf ? eok1(actT) : '—'}</div></div>
    <div><div class="k">동일매장 성장율</div><div class="v">${ssg ? (ssg.g >= 0 ? '+' : '') + ssg.g.toFixed(1) + '%' : '—'}</div>
      <div class="s">${ssg ? `전년 ${ssg.from.slice(5).replace('-', '/')}~${ssg.to.slice(5).replace('-', '/')} (요일 맞춤·공휴일 제외) · ${ssg.n}개점` : '실적 업로드 대기'}</div></div>
    <div><div class="k">전년 동월 대비</div><div class="v">${yoyT === null ? '—' : (yoyT >= 0 ? '+' : '') + yoyT.toFixed(1) + '%'}</div>
      <div class="s">${pyT ? `${ymLabel(prevYearYm)} 실적 ${eok(pyT)}` : '전년 데이터 없음'}</div></div>`;

  $('brandTable').innerHTML = `
    <table class="data-table" style="min-width:680px">
      <colgroup><col style="width:200px"><col style="width:130px"><col style="width:130px"><col style="width:130px"><col style="width:110px"></colgroup>
      <thead><tr><th>매장</th><th>월초 예상매출</th><th>누적 매출</th><th>현재 예상매출</th><th>오차율</th></tr></thead>
      <tbody>
      ${rows.map(r => `<tr data-code="${r.code}" style="cursor:pointer">
        <td>${r.name} <span style="color:var(--muted2);font-size:11px">${r.code}</span></td>
        <td style="text-align:right">${eok(r.fc)}</td>
        <td style="text-align:right">${asOf ? eok(r.act) : '—'}</td>
        <td style="text-align:right"><b>${eok(r.landing)}</b></td>
        <td style="text-align:right">${r.fc ? `<b style="color:${Math.abs(r.landing / r.fc - 1) <= 0.03 ? 'var(--good)' : Math.abs(r.landing / r.fc - 1) <= 0.07 ? 'var(--warn)' : 'var(--crit)'}">${((r.landing / r.fc - 1) * 100).toFixed(1)}%</b>` : '—'}</td>
      </tr>`).join('')}
      <tr style="font-weight:700;border-top:2px solid var(--outline)">
        <td>합계</td><td style="text-align:right">${eok(fcT)}</td><td style="text-align:right">${asOf ? eok(actT) : '—'}</td>
        <td style="text-align:right">${eok(landT)}</td>
        <td style="text-align:right">${fcT ? ((landT / fcT - 1) * 100).toFixed(1) + '%' : '—'}</td>
      </tr>
      </tbody>
    </table>`;
  $('brandTable').querySelectorAll('tr[data-code]').forEach(tr => tr.onclick = () => {
    $('dailyStore').value = tr.dataset.code; $('dailyMonth').value = ym; renderDaily(); showView('daily');
  });

  // 누적 차트 — Chart.js 미로드 환경(사내망 CDN 차단 등)에서도 표·KPI는 정상 동작해야 함
  if (typeof Chart === 'undefined') return;
  const fcCum = [], actCum = [];
  let cf = 0, ca = 0;
  for (const d of dates) {
    cf += Object.values(st).reduce((t, f) => t + (f.daily[d] || 0), 0); fcCum.push(cf / 1e8);
    if (asOf && d <= asOf) { ca += Object.keys(st).reduce((t, c) => t + ((SALES[c] || new Map()).get(d) || 0), 0); actCum.push(ca / 1e8); }
    else actCum.push(null);
  }
  if (brandChartObj) brandChartObj.destroy();
  brandChartObj = new Chart($('brandChart'), {
    type: 'line',
    data: {
      labels: dates.map(d => +d.slice(8)),
      datasets: [
        { label: '예측 누적(억)', data: fcCum, borderColor: cssVar('--dark') || '#2f3030', borderDash: [6, 4], pointRadius: 0, borderWidth: 2.5 },
        { label: '실적 누적(억)', data: actCum, borderColor: cssVar('--good') || '#3f9e12', backgroundColor: 'transparent', pointRadius: 3, borderWidth: 3.5 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 18, font: { size: 11 } } } },
      scales: { y: { ticks: { font: { size: 11 } } }, x: { ticks: { font: { size: 10 }, maxTicksLimit: 16 } } },
    },
  });
}

// ---------- V2 매장 일별 캘린더 ----------
function renderDaily() {
  const code = $('dailyStore').value || Object.keys(OT_DATA)[0];
  const ym = $('dailyMonth').value;
  const run = getRun(ym);
  const f = run ? run.daily.stores[code] : null;
  const m = SALES[code] || new Map();
  const dates = monthDates(ym);
  const prevYearYm = shiftYm(ym, -12);

  let fcT = 0, actT = 0, fcOnAct = 0, py = 0, apeSum = 0, apeN = 0, openDays = 0;
  for (const d of dates) {
    const fv = f ? (f.daily[d] || 0) : 0, av = m.get(d) || 0;
    fcT += fv; if (fv > 0) openDays++;
    if (av > 0) { actT += av; fcOnAct += fv; if (fv > 0) { apeSum += Math.abs(av - fv) / av; apeN++; } }
  }
  for (const d of monthDates(prevYearYm)) py += (m.get(d) || 0);

  $('dailyKpis').innerHTML = `
    <div><div class="k">${ymLabel(ym)} 예측 합</div><div class="v">${f ? eok(fcT) : '—'}</div><div class="s">${f ? `영업 ${openDays}일 · ${f.src}` : '미발행'}</div></div>
    <div><div class="k">실적 누계</div><div class="v">${actT ? eok(actT) : '—'}</div><div class="s">${actT && fcOnAct ? `같은 기간 예측 ${eok(fcOnAct)} (${(actT / fcOnAct * 100).toFixed(1)}%)` : '실적 업로드 대기'}</div></div>
    <div><div class="k">일평균 오차 (MAPE)</div><div class="v">${apeN ? (apeSum / apeN * 100).toFixed(1) + '%' : '—'}</div><div class="s">${apeN ? `실적 있는 ${apeN}일 기준` : '실적 쌓이면 자동 계산'}</div></div>
    <div><div class="k">전년 동월 실적</div><div class="v">${py ? eok(py) : '—'}</div><div class="s">${py && f ? `예측 YoY ${((fcT / py - 1) * 100).toFixed(0)}%` : ymLabel(prevYearYm)}</div></div>`;

  let html = WD.map(w => `<div class="ch">${w}</div>`).join('');
  const lead = dowIdx(dates[0]);
  for (let i = 0; i < lead; i++) html += '<div></div>';
  for (const d of dates) {
    const fv = f ? (f.daily[d] || 0) : null, av = m.get(d);
    const closed = isClosed(code, d) || (fv === 0 && f && !av);
    const newNotOpen = NEW_OPEN[code] && d < NEW_OPEN[code];
    const hol = isHol(d);
    let body;
    if (newNotOpen) body = `<div class="fc" style="color:var(--muted2)">오픈 전</div>`;
    else if (closed) body = `<div class="fc" style="color:var(--muted2)">휴점</div>`;
    else {
      body = av > 0 ? `<div class="ac">${man(av)}</div>` : '';
      body += fv !== null ? `<div class="fc">예 ${man(fv)}</div>` : '';
      if (av > 0 && fv > 0) {
        const p = (av - fv) / fv * 100;
        body += `<span class="df ${p >= 0 ? 'up' : 'dn'}">${p >= 0 ? '+' : ''}${p.toFixed(0)}%</span>`;
      }
    }
    const tag = NEW_OPEN[code] && d === NEW_OPEN[code] ? '<span class="tag">오픈</span>' : '';
    html += `<div class="cd${closed || newNotOpen ? ' off' : ''}${hol ? ' hol' : ''}"><span class="dnum">${+d.slice(8)}</span>${tag}${body}</div>`;
  }
  $('calGrid').innerHTML = html;
}

// ---------- V4 발행 관리 ----------
function renderRuns() {
  if (!RUNS.length) { $('runsTable').innerHTML = '<div class="placeholder-box"><b>발행 이력이 없습니다.</b></div>'; return; }
  $('runsTable').innerHTML = `
    <table class="data-table" style="min-width:640px">
      <colgroup><col style="width:110px"><col style="width:70px"><col style="width:60px"><col style="width:80px"><col style="width:110px"><col style="width:110px"><col style="width:110px"></colgroup>
      <thead><tr><th>대상 월</th><th>구분</th><th>버전</th><th>모델</th><th>컷오프</th><th>발행일</th><th>월 예측 합</th></tr></thead>
      <tbody>${RUNS.map(r => {
        const tot = Object.values(r.daily.stores || {}).reduce((t, f) => t + (f.total || 0), 0);
        return `<tr><td>${ymLabel(r.ym)}</td><td>${r.kind}</td><td>v${r.version}</td><td>${r.model_version}</td>
          <td>${r.cutoff_date}</td><td>${String(r.published_at).slice(0, 10)}</td><td style="text-align:right">${eok(tot)}</td></tr>`;
      }).join('')}</tbody>
    </table>`;
}

$('pubBtn').onclick = async () => {
  const ym = $('pubMonth').value, cutoff = cutoffOf(ym);
  const msg = $('pubMsg');
  const existing = RUNS.filter(r => r.ym === ym && r.kind === '확정');
  const version = existing.length ? Math.max(...existing.map(r => r.version)) + 1 : 1;
  if (existing.length && !confirm(`${ymLabel(ym)} 확정 예측이 이미 v${existing[0].version}까지 발행되어 있습니다.\nv${version}(으)로 재발행할까요? (기존 버전은 이력으로 보존)`)) return;
  msg.textContent = '계산 중…'; msg.className = 'plan-msg';
  try {
    const fc = computeForecast(ym, cutoff);
    const { error } = await sb.from('sf_forecast_runs').insert({
      ym, version, kind: '확정', model_version: MODEL_VERSION, cutoff_date: cutoff,
      daily: fc, created_by: currentUser.id,
      note: `sfv1 확정 발행 (컷오프 ${cutoff}, 199전환 이전 데이터 미사용, RU046 가정치)`,
    });
    if (error) throw error;
    await loadRuns();
    buildSelectors(); renderRuns();
    $('brandMonth').value = ym; renderBrand();
    const tot = Object.values(fc.stores).reduce((t, f) => t + f.total, 0);
    msg.textContent = `발행 완료: ${ymLabel(ym)} 확정 v${version} · 합계 ${eok(tot)}`;
    msg.className = 'plan-msg ok';
  } catch (e) { msg.textContent = '실패: ' + e.message; msg.className = 'plan-msg err'; }
};

init();
