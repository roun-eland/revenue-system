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
let SF_EVENTS = []; // 매장 이벤트 기록 (가격변경·공사·오픈 등) — 주차별 특이사항 주석에 사용
async function loadEvents() {
  const { data } = await sb.from('sf_events').select('store_code,start_date,end_date,kind,memo');
  SF_EVENTS = data || [];
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
    await Promise.all([loadSales(), loadRuns(), loadEvents()]);
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
  for (const k of ['brand', 'daily', 'weekly', 'acc', 'admin']) $('view-' + k).hidden = (k !== v);
  if (v === 'weekly') renderWeekly();
  if (v === 'acc') renderAcc();
}
document.querySelectorAll('#sfNav button').forEach(b => { if (!b.disabled) b.onclick = () => showView(b.dataset.view); });

// ---------- 셀렉터 ----------
function buildSelectors() {
  const runYms = [...new Set(RUNS.filter(r => r.kind === '확정').map(r => r.ym))].sort().reverse();
  const yms = runYms.length ? runYms : ['2026-09'];
  for (const id of ['brandMonth', 'dailyMonth', 'accMonth']) {
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
  const ws = $('wkStore');
  if (!ws.options.length) {
    for (const c of Object.keys(OT_DATA).sort()) {
      const o = document.createElement('option');
      o.value = c; o.textContent = `${OT_DATA[c].name} (${c})`;
      ws.appendChild(o);
    }
    const wy = $('wkYear');
    for (const y of [2026, 2025, 2024]) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y + '년';
      wy.appendChild(o);
    }
  }
  $('brandMonth').onchange = renderBrand;
  $('dailyMonth').onchange = renderDaily;
  $('dailyStore').onchange = renderDaily;
  $('wkStore').onchange = renderWeekly;
  $('wkYear').onchange = renderWeekly;
  $('accMonth').onchange = renderAcc;
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
// byStore에 매장별 성장율도 담아 표에서 재사용.
function sameStoreGrowth(ym, asOf) {
  if (!asOf) return null;
  let cur = 0, prv = 0, nStores = 0;
  const byStore = {};
  for (const code of Object.keys(OT_DATA)) {
    const m = SALES[code]; if (!m) continue;
    let c = 0, p = 0;
    for (let d = ym + '-01'; d <= asOf; d = addD(d, 1)) {
      const pd = addD(d, -364);
      if (isHolCmp(d) || isHolCmp(pd)) continue;
      const cv = m.get(d), pv = m.get(pd);
      if (cv > 0 && pv > 0) { c += cv; p += pv; }
    }
    if (c > 0 && p > 0) { cur += c; prv += p; nStores++; byStore[code] = (c / p - 1) * 100; }
  }
  return prv ? { g: (cur / prv - 1) * 100, n: nStores, from: addD(ym + '-01', -364), to: addD(asOf, -364), byStore } : null;
}
// 성장율 밴드색: 음수 빨강 / 0~5% 주황 / 5% 이상 초록
const growColor = g => g < 0 ? 'var(--crit)' : g < 5 ? 'var(--warn)' : 'var(--good)';
const signColor = v => v >= 0 ? 'var(--good)' : 'var(--crit)';

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
  const vsT = fcT ? (landT / fcT - 1) * 100 : 0;
  $('brandKpis').innerHTML = `
    <div><div class="k">월초 예상 매출</div><div class="v">${eok1(fcT)}</div><div class="s">18개 매장 · 확정 v${run.version}</div></div>
    <div><div class="k">현재 예상 매출</div><div class="v">${eok1(landT)}</div><div class="s">예측 대비 <b style="color:${signColor(vsT)}">${vsT >= 0 ? '+' : ''}${vsT.toFixed(1)}%</b> · 누적 매출 ${asOf ? eok1(actT) : '—'}</div></div>
    <div><div class="k">동일매장 성장율</div><div class="v" style="color:${ssg ? growColor(ssg.g) : 'inherit'}">${ssg ? (ssg.g >= 0 ? '+' : '') + ssg.g.toFixed(1) + '%' : '—'}</div>
      <div class="s">${ssg ? `전년 ${ssg.from.slice(5).replace('-', '/')}~${ssg.to.slice(5).replace('-', '/')} (요일 맞춤·공휴일 제외) · ${ssg.n}개점` : '실적 업로드 대기'}</div></div>
    <div><div class="k">전년 동월 대비</div><div class="v" style="color:${yoyT === null ? 'inherit' : signColor(yoyT)}">${yoyT === null ? '—' : (yoyT >= 0 ? '+' : '') + yoyT.toFixed(1) + '%'}</div>
      <div class="s">${pyT ? `${ymLabel(prevYearYm)} 실적 ${eok(pyT)}` : '전년 데이터 없음'}</div></div>`;

  // 오차율 바: 0 기준 좌우 벌어짐을 한눈에 — 최대 |오차율| 대비 폭
  const errOf = r => r.fc ? (r.landing / r.fc - 1) * 100 : null;
  const maxErr = Math.max(...rows.map(r => Math.abs(errOf(r) || 0)), 0.1);
  const errCell = v => v === null ? '—'
    : `<b style="color:${signColor(v)}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</b> <span class="mini" style="width:${Math.max(2, Math.round(Math.abs(v) / maxErr * 70))}px;${v < 0 ? 'background:var(--crit)' : ''}"></span>`;
  const growCell = g => g == null ? '<span style="color:var(--muted2)">—</span>'
    : `<b style="color:${growColor(g)}">${g >= 0 ? '+' : ''}${g.toFixed(1)}%</b>`;
  $('brandTable').innerHTML = `
    <table class="data-table" style="min-width:820px">
      <colgroup><col style="width:190px"><col style="width:120px"><col style="width:110px"><col style="width:120px"><col style="width:170px"><col style="width:120px"></colgroup>
      <thead><tr><th>매장</th><th>월초 예상매출</th><th>누적 매출</th><th>현재 예상매출</th><th>오차율</th><th>동일매장 성장율</th></tr></thead>
      <tbody>
      ${rows.map(r => `<tr data-code="${r.code}" style="cursor:pointer">
        <td>${r.name} <span style="color:var(--muted2);font-size:11px">${r.code}</span></td>
        <td style="text-align:right">${eok(r.fc)}</td>
        <td style="text-align:right">${asOf ? eok(r.act) : '—'}</td>
        <td style="text-align:right"><b>${eok(r.landing)}</b></td>
        <td style="text-align:right;white-space:nowrap">${errCell(errOf(r))}</td>
        <td style="text-align:right">${growCell(ssg && ssg.byStore[r.code] != null ? ssg.byStore[r.code] : null)}</td>
      </tr>`).join('')}
      <tr style="font-weight:700;border-top:2px solid var(--outline)">
        <td>합계</td><td style="text-align:right">${eok(fcT)}</td><td style="text-align:right">${asOf ? eok(actT) : '—'}</td>
        <td style="text-align:right">${eok(landT)}</td>
        <td style="text-align:right;white-space:nowrap">${fcT ? errCell(vsT) : '—'}</td>
        <td style="text-align:right">${growCell(ssg ? ssg.g : null)}</td>
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

// ---------- V2b 주차별 매출 (실적 전용, 주 = 월~일 — 생산성 급여 주차(화~월)와 다른 기준) ----------
let weeklyChartObj = null;

// 특이사항 주석용 공휴일·명절 달력 (2024~) — 모델 산출에는 사용하지 않음
const SF_HOL_ANNOT = new Set([...OT_HOLIDAYS, ...SF_PAST_HOLIDAYS,
  '2024-01-01', '2024-02-09', '2024-02-10', '2024-02-11', '2024-02-12', '2024-03-01', '2024-04-10',
  '2024-05-05', '2024-05-06', '2024-05-15', '2024-06-06', '2024-08-15', '2024-09-16', '2024-09-17',
  '2024-09-18', '2024-10-03', '2024-10-09', '2024-12-25',
  '2025-01-01', '2025-01-27', '2025-01-28', '2025-01-29', '2025-01-30', '2025-03-01', '2025-03-03',
  '2025-05-05', '2025-05-06', '2025-06-03', '2025-06-06']);
// 명절 당일 (전점 휴무 관례)
const SF_FEST = new Set(['2024-02-10', '2024-09-17', '2025-01-29', '2025-10-06', '2026-02-17', '2026-09-25', '2027-02-07', '2027-09-15']);

// 1주차 = 1월 1일이 포함된 월~일 주
function weeksOfYear(y) {
  let start = `${y}-01-01`;
  start = addD(start, -dowIdx(start));
  const weeks = [];
  for (let i = 0; ; i++) {
    const s = addD(start, i * 7);
    if (s > `${y}-12-31`) break;
    weeks.push({ n: i + 1, s, e: addD(s, 6) });
  }
  return weeks;
}

function renderWeekly() {
  const code = $('wkStore').value || Object.keys(OT_DATA)[0];
  const year = +($('wkYear').value || new Date().getFullYear());
  const m = SALES[code] || new Map();
  const allDates = [...m.keys()].sort();
  const first = allDates[0], last = allDates[allDates.length - 1];
  const weeks = weeksOfYear(year);
  const today = dStr(new Date());

  const sumWeek = (s, e, map) => {
    let t = 0, days = 0;
    for (let d = s; d <= e; d = addD(d, 1)) { const v = map.get(d); if (v > 0) { t += v; days++; } }
    return { t, days };
  };

  const rows = weeks.map(w => {
    const { t, days } = sumWeek(w.s, w.e, m);
    // 전년 같은 주차 번호
    const pw = weeksOfYear(year - 1)[w.n - 1];
    const pv = pw ? sumWeek(pw.s, pw.e, m).t : 0;

    // 특이사항 수집
    const tags = [];
    if (first && w.e >= first && w.s <= first && first > `${year}-01-01`) tags.push({ c: 'i', t: '오픈' });
    let hol = 0, fest = false;
    for (let d = w.s; d <= w.e; d = addD(d, 1)) {
      if (SF_FEST.has(d)) fest = true;
      else if (SF_HOL_ANNOT.has(d)) hol++;
    }
    if (fest) tags.push({ c: 'i', t: '명절 (당일 전점휴무)' });
    else if (hol) tags.push({ c: 'i', t: `공휴일 ${hol}일` });
    // 매장 이벤트: 기간형은 겹치는 주 전부, 시점형(end 없음)은 시작일이 든 주만
    for (const ev of SF_EVENTS) {
      if (ev.store_code && ev.store_code !== code) continue;
      const hit = ev.end_date ? (ev.start_date <= w.e && ev.end_date >= w.s)
        : (ev.start_date >= w.s && ev.start_date <= w.e);
      if (hit) tags.push({ c: 'e', t: ev.kind + (ev.end_date ? '' : ' 시작') });
    }
    // 미영업일: 데이터 범위 안(과거)인데 7일이 다 없는 주
    const inRange = first && w.s >= first && w.e <= (last < today ? last : today);
    if (inRange && days < 7 && days > 0 && !fest) tags.push({ c: 'i', t: `미영업 ${7 - days}일` });
    if (inRange && days === 0) tags.push({ c: 'w', t: '휴점/데이터 없음' });
    return { w, t, days, pv, tags };
  });

  // 전주 대비 + 요인 없는 급변 플래그
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i], b = rows[i - 1];
    if (a.t > 0 && b.t > 0 && b.days === 7 && a.days === 7) {
      a.wow = (a.t / b.t - 1) * 100;
      if (Math.abs(a.wow) >= 15 && !a.tags.length && !b.tags.length) a.tags.push({ c: 'w', t: a.wow > 0 ? '급증 — 요인 미확인' : '급감 — 요인 미확인' });
    }
  }

  $('wkChartTitle').textContent = `${OT_DATA[code].name} ${year}년 주차별 매출 (백만원)`;
  if (typeof Chart !== 'undefined') {
    if (weeklyChartObj) weeklyChartObj.destroy();
    weeklyChartObj = new Chart($('wkChart'), {
      data: {
        labels: rows.map(r => r.w.n),
        datasets: [
          { type: 'bar', label: `${year} 주간 매출(백만)`, data: rows.map(r => r.t ? +(r.t / 1e6).toFixed(1) : null),
            backgroundColor: rows.map(r => r.tags.some(x => x.c === 'w') ? 'rgba(217,83,79,.55)' : 'rgba(130,220,40,.55)'),
            borderColor: 'transparent' },
          { type: 'line', label: `${year - 1} 같은 주차(백만)`, data: rows.map(r => r.pv ? +(r.pv / 1e6).toFixed(1) : null),
            borderColor: cssVar('--dark') || '#2f3030', borderDash: [6, 4], borderWidth: 2, pointRadius: 0, spanGaps: true },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { boxWidth: 18, font: { size: 11 } } },
          tooltip: { callbacks: { afterBody: items => {
            const r = rows[items[0].dataIndex];
            return [`기간 ${r.w.s.slice(5)}~${r.w.e.slice(5)}`].concat(r.tags.map(x => '· ' + x.t));
          } } } },
        scales: { y: { ticks: { font: { size: 11 } } }, x: { ticks: { font: { size: 10 }, maxTicksLimit: 26 } } },
      },
    });
  }

  const tagHtml = tags => tags.map(x =>
    `<span style="display:inline-block;font-size:11px;font-weight:700;border-radius:9px;padding:0 7px;margin-right:4px;` +
    (x.c === 'w' ? 'background:var(--hol-bg);color:var(--crit)' : x.c === 'e' ? 'background:var(--fill);color:var(--ink)' : 'background:var(--accent-bg);color:var(--good)') +
    `">${x.t}</span>`).join('');
  const pct = v => v == null ? '—' : `<span style="color:${v >= 0 ? 'var(--good)' : 'var(--crit)'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
  $('wkTable').innerHTML = `
    <table class="data-table" style="min-width:760px">
      <colgroup><col style="width:70px"><col style="width:120px"><col style="width:110px"><col style="width:95px"><col style="width:110px"><col></colgroup>
      <thead><tr><th>주차</th><th>기간</th><th>매출</th><th>전주 대비</th><th>전년 동주차</th><th>특이사항</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr${r.tags.some(x => x.c === 'w') ? ' style="background:var(--hol-bg)"' : ''}>
          <td>${r.w.n}주차</td>
          <td style="color:var(--muted)">${r.w.s.slice(5).replace('-', '/')}~${r.w.e.slice(5).replace('-', '/')}</td>
          <td style="text-align:right"><b>${r.t ? won(r.t / 10000) + '만' : '—'}</b></td>
          <td style="text-align:right">${pct(r.wow != null ? r.wow : null)}</td>
          <td style="text-align:right">${r.t && r.pv ? pct((r.t / r.pv - 1) * 100) : '—'}</td>
          <td>${tagHtml(r.tags)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

// ---------- V3 정확도 피드백 ----------
// 얼마나 맞았나(KPI) → 어디서 틀렸나(매장·일) → 왜 틀렸나(원인 태깅, sf_error_notes) → 무엇을 고칠까(요일 진단·버전 비교)
const ERR_TAGS = ['날씨', '유통점 행사', '단체·이벤트', '프로모션', '휴점정보 오류', '상권 특이', '기타'];
let accDowChartObj = null;

async function renderAcc() {
  const ym = $('accMonth').value;
  const run = getRun(ym);
  if (!run) {
    $('accKpis').innerHTML = '';
    $('accWorst').innerHTML = $('accTable').innerHTML = $('accVers').innerHTML =
      `<div class="placeholder-box"><b>${ymLabel(ym)} 확정 예측이 없습니다.</b></div>`;
    return;
  }
  const asOf = lastActualDate(ym);
  if (!asOf) {
    $('accKpis').innerHTML = '';
    $('accWorst').innerHTML = $('accTable').innerHTML = $('accVers').innerHTML =
      `<div class="placeholder-box"><b>${ymLabel(ym)} 실적이 아직 없습니다.</b><br>생산성 > 실적 입력에서 일별매출을 올리면 자동 계산됩니다.</div>`;
    return;
  }
  const { data: notesRaw } = await sb.from('sf_error_notes').select('*')
    .gte('err_date', ym + '-01').lte('err_date', `${ym}-${String(daysIn(ym)).padStart(2, '0')}`);
  const notesBy = {};
  (notesRaw || []).forEach(n => (notesBy[n.store_code + '|' + n.err_date] = notesBy[n.store_code + '|' + n.err_date] || []).push(n));

  // 일 단위 (예측·실적 모두 있는 날만 — 휴점·미적재 제외)
  const st = run.daily.stores, dates = monthDates(ym).filter(d => d <= asOf);
  const pairs = [];
  for (const [code, f] of Object.entries(st)) {
    const m = SALES[code] || new Map();
    for (const d of dates) {
      const fv = f.daily[d] || 0, av = m.get(d) || 0;
      if (fv > 0 && av > 0) pairs.push({ code, name: f.name, d, f: fv, a: av });
    }
  }

  // 매장별 지표
  const rows = Object.entries(st).map(([code, f]) => {
    const ps = pairs.filter(p => p.code === code);
    const sa = ps.reduce((t, p) => t + p.a, 0), sf2 = ps.reduce((t, p) => t + p.f, 0);
    const sad = ps.reduce((t, p) => t + Math.abs(p.a - p.f), 0);
    const m = SALES[code] || new Map();
    let landing = 0;
    for (const d of monthDates(ym)) landing += (d <= asOf ? (m.get(d) || 0) : (f.daily[d] || 0));
    return { code, name: f.name, fc: f.total, act: sa, landing, n: ps.length,
      err: f.total ? (landing / f.total - 1) * 100 : null,
      wape: sa ? sad / sa * 100 : null, bias: sa ? (sf2 - sa) / sa * 100 : null, src: f.src };
  }).sort((a, b) => (a.code < b.code ? -1 : 1));

  const saT = pairs.reduce((t, p) => t + p.a, 0), sfT = pairs.reduce((t, p) => t + p.f, 0);
  const sadT = pairs.reduce((t, p) => t + Math.abs(p.a - p.f), 0);
  const fcT = rows.reduce((t, r) => t + r.fc, 0), landT = rows.reduce((t, r) => t + r.landing, 0);
  const errT = fcT ? (landT / fcT - 1) * 100 : 0;
  const measurable = rows.filter(r => r.n > 0);
  const hit = measurable.filter(r => Math.abs(r.err) <= 5).length;
  const biasT = saT ? (sfT - saT) / saT * 100 : 0;

  $('accKpis').innerHTML = `
    <div><div class="k">월 오차율</div><div class="v" style="color:${Math.abs(errT) <= 5 ? 'var(--good)' : 'var(--warn)'}">${errT >= 0 ? '+' : ''}${errT.toFixed(1)}%</div><div class="s">확정 v${run.version} 대비 · 실적 반영 ~${asOf.slice(5).replace('-', '/')}</div></div>
    <div><div class="k">일평균 오차 (MAPE)</div><div class="v">${saT ? (sadT / saT * 100).toFixed(1) + '%' : '—'}</div><div class="s">매출가중 · ${pairs.length}일치 (매장×일)</div></div>
    <div><div class="k">적중 매장 (±5%)</div><div class="v">${hit} / ${measurable.length}</div><div class="s">월 오차율 기준 · 실적 있는 매장만</div></div>
    <div><div class="k">편향 (Bias)</div><div class="v" style="color:${Math.abs(biasT) <= 2 ? 'var(--good)' : 'var(--warn)'}">${biasT >= 0 ? '+' : ''}${biasT.toFixed(1)}%</div><div class="s">${biasT > 2 ? '전반적으로 과대예측 경향' : biasT < -2 ? '전반적으로 과소예측 경향' : '체계적 편향 없음'}</div></div>`;

  // 오차 상위일 (금액 기준 상위 15)
  const worst = [...pairs].sort((x, y) => Math.abs(y.a - y.f) - Math.abs(x.a - x.f)).slice(0, 15);
  $('accWorst').innerHTML = `
    <table class="data-table" style="min-width:820px">
      <colgroup><col style="width:150px"><col style="width:100px"><col style="width:90px"><col style="width:90px"><col style="width:95px"><col style="width:130px"><col></colgroup>
      <thead><tr><th>매장</th><th>일자</th><th>실적(만)</th><th>예측(만)</th><th>오차</th><th>태그</th><th>메모</th></tr></thead>
      <tbody>${worst.map(p => {
        const e = (p.a / p.f - 1) * 100;
        const exist = (notesBy[p.code + '|' + p.d] || []).map(n => `${n.tag}${n.memo ? '·' + n.memo : ''}`).join(', ');
        return `<tr><td>${p.name}</td><td>${+p.d.slice(8)}일(${WD[dowIdx(p.d)]})</td>
          <td style="text-align:right">${won(p.a / 1e4)}</td><td style="text-align:right">${won(p.f / 1e4)}</td>
          <td style="text-align:right"><b style="color:${signColor(e)}">${e >= 0 ? '+' : ''}${e.toFixed(0)}%</b></td>
          <td><select class="acc-tag" data-code="${p.code}" data-date="${p.d}" style="height:30px;padding:0 6px;font-size:12px"><option value="">선택</option>${ERR_TAGS.map(t => `<option>${t}</option>`).join('')}</select></td>
          <td><input class="acc-memo" data-code="${p.code}" data-date="${p.d}" placeholder="${exist || '메모(선택)'}" style="height:30px;font-size:12px;padding:0 8px;width:100%"></td></tr>`;
      }).join('')}</tbody>
    </table>`;
  $('accSaveNotes').onclick = async () => {
    const out = [];
    document.querySelectorAll('.acc-tag').forEach(sel2 => {
      if (!sel2.value) return;
      const memo = document.querySelector(`.acc-memo[data-code="${sel2.dataset.code}"][data-date="${sel2.dataset.date}"]`)?.value || null;
      out.push({ store_code: sel2.dataset.code, err_date: sel2.dataset.date, tag: sel2.value, memo, created_by: currentUser?.id });
    });
    const msg = $('accNoteMsg');
    if (!out.length) { msg.className = 'plan-msg err'; msg.textContent = '태그를 선택한 행이 없습니다.'; return; }
    const { error } = await sb.from('sf_error_notes').insert(out);
    if (error) { msg.className = 'plan-msg err'; msg.textContent = '저장 실패: ' + error.message; }
    else { msg.className = 'plan-msg ok'; msg.textContent = `${out.length}건 저장됨`; renderAcc(); }
  };

  // 매장별 표
  $('accTable').innerHTML = `
    <table class="data-table" style="min-width:820px">
      <colgroup><col style="width:180px"><col style="width:110px"><col style="width:100px"><col style="width:95px"><col style="width:90px"><col style="width:95px"><col style="width:90px"><col style="width:80px"></colgroup>
      <thead><tr><th>매장</th><th>월초 예상매출</th><th>누적 매출</th><th>오차율</th><th>MAPE</th><th>편향</th><th>계수</th><th>적중</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr data-code="${r.code}" style="cursor:pointer">
          <td>${r.name} <span style="color:var(--muted2);font-size:11px">${r.code}</span></td>
          <td style="text-align:right">${eok(r.fc)}</td>
          <td style="text-align:right">${r.n ? eok(r.act) : '—'}</td>
          <td style="text-align:right">${r.err != null && r.n ? `<b style="color:${signColor(r.err)}">${r.err >= 0 ? '+' : ''}${r.err.toFixed(1)}%</b>` : '—'}</td>
          <td style="text-align:right">${r.wape != null ? r.wape.toFixed(1) + '%' : '—'}</td>
          <td style="text-align:right">${r.bias != null ? `<span style="color:${Math.abs(r.bias) <= 3 ? 'var(--muted)' : 'var(--warn)'}">${r.bias >= 0 ? '+' : ''}${r.bias.toFixed(1)}%</span>` : '—'}</td>
          <td style="font-size:11px;color:var(--muted2)">${r.src}</td>
          <td>${r.n ? (Math.abs(r.err) <= 5 ? '<span class="band g">적중</span>' : '<span class="band w">이탈</span>') : '—'}</td>
        </tr>`).join('')}</tbody>
    </table>`;
  $('accTable').querySelectorAll('tr[data-code]').forEach(tr => tr.onclick = () => {
    $('dailyStore').value = tr.dataset.code; $('dailyMonth').value = ym; renderDaily(); showView('daily');
  });

  // 요일 진단 (브랜드 합산: 요일별 Σ실적/Σ예측 − 1)
  const dow = Array.from({ length: 7 }, () => ({ a: 0, f: 0 }));
  pairs.forEach(p => { const i = dowIdx(p.d); dow[i].a += p.a; dow[i].f += p.f; });
  const dowErr = dow.map(x => x.f ? (x.a / x.f - 1) * 100 : null);
  if (typeof Chart !== 'undefined') {
    if (accDowChartObj) accDowChartObj.destroy();
    accDowChartObj = new Chart($('accDowChart'), {
      type: 'bar',
      data: { labels: WD, datasets: [{ label: '실적/예측 − 1 (%)', data: dowErr,
        backgroundColor: dowErr.map(v => v == null ? '#ccc' : v >= 0 ? 'rgba(130,220,40,.6)' : 'rgba(217,83,79,.55)') }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } }, scales: { y: { ticks: { font: { size: 11 }, callback: v => v + '%' } } } },
    });
  }

  // 발행 버전별 사후 정확도 (같은 실적 구간에 각 버전의 예측을 대입)
  const versions = RUNS.filter(r => r.ym === ym && r.kind === '확정').sort((a, b) => a.version - b.version);
  $('accVers').innerHTML = `
    <table class="data-table" style="min-width:360px">
      <colgroup><col style="width:70px"><col style="width:100px"><col style="width:90px"><col style="width:90px"></colgroup>
      <thead><tr><th>버전</th><th>월초 예측 합</th><th>MAPE</th><th>월 오차율</th></tr></thead>
      <tbody>${versions.map(v => {
        const vs = v.daily.stores;
        let sa = 0, sad = 0, tot = 0, land = 0;
        for (const [code, f] of Object.entries(vs)) {
          const m = SALES[code] || new Map();
          tot += f.total || 0;
          for (const d of monthDates(ym)) {
            const fv = f.daily[d] || 0, av = d <= asOf ? (m.get(d) || 0) : 0;
            if (d <= asOf) { land += av; if (fv > 0 && av > 0) { sa += av; sad += Math.abs(av - fv); } }
            else land += fv;
          }
        }
        const cur = v.version === run.version;
        return `<tr${cur ? ' style="font-weight:700"' : ''}><td>v${v.version}${cur ? ' ◀' : ''}</td>
          <td style="text-align:right">${eok(tot)}</td>
          <td style="text-align:right">${sa ? (sad / sa * 100).toFixed(1) + '%' : '—'}</td>
          <td style="text-align:right">${tot ? ((land / tot - 1) * 100).toFixed(1) + '%' : '—'}</td></tr>`;
      }).join('')}</tbody>
    </table>`;
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
