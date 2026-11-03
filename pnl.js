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
const MANUAL_NOTE = '표에서 직접 입력';   // 표 칸에서 직접 고친 특이비용은 이 메모의 한 줄로 모은다
const FOOD_TAX_PCT = 0.008;   // 의제매입세액 공제액 — 순매출의 0.8% (원본 손익표가 전 매장 -0.8%) — 가정, 값이 바뀌면 여기만 고친다
const STORES = Object.keys(OT_DATA);
const sname = c => ((OT_DATA[c] && OT_DATA[c].name) || c).replace(/\s*\(신규\)\s*/g, '');   // 화면에는 매장명만 (신규 표기 제외)

const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };
const lastDay = ym => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

const S = { ym: null, tab: 'brand', mode: 'l1', scope: 'all', pick: null, folded: new Set(), months: [], D: null, adj: [] };

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
  if (role !== 'planner') {
    $('plNav').hidden = true;
    $('plMain').innerHTML = '<h2>예상실적</h2><p class="view-sub">손익 자료는 기획자만 볼 수 있습니다.</p>';
    return;
  }
  document.querySelectorAll('#plNav button').forEach(b => { b.onclick = () => showTab(b.dataset.view); });
  document.querySelectorAll('#plMode button').forEach(b => { b.onclick = () => { S.mode = b.dataset.mode; renderAll(); }; });
  document.querySelectorAll('#plScope button').forEach(b => { b.onclick = () => { S.scope = b.dataset.scope; renderAll(); }; });
  $('plPick').onchange = () => { S.pick = $('plPick').value; renderAll(); };
  $('plMonth').onchange = () => loadMonth($('plMonth').value);
  $('adjAdd').onclick = addAdjust;
  $('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.replace('../'); };
  fillAdjustAccounts();
  await loadMonths();
  showTab(typeof navStart === 'function' ? navStart('brand') : 'brand');
}
$('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.replace('../'); };

function showTab(t) {
  S.tab = t === 'store' ? 'store' : 'brand';
  document.querySelectorAll('#plNav button').forEach(b => b.classList.toggle('on', b.dataset.view === S.tab));
  $('view-brand').hidden = S.tab !== 'brand';
  $('view-store').hidden = S.tab !== 'store';
  $('plMode').hidden = S.tab === 'store';   // 매장 탭은 주요 계정 고정, 대신 전체 매장/매장 선택
  $('plScope').hidden = S.tab !== 'store';
  renderAll();
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
    const [D, adj] = await Promise.all([loadData(ym), loadAdjust(ym)]);
    S.D = D; S.adj = adj;
    setMsg('');
    renderAll();
  } catch (e) { setMsg('불러오기 실패: ' + (e.message || e), true); }
}

async function loadAdjust(ym) {
  const { data, error } = await sb.from('pnl_adjust').select('*').eq('ym', ym).order('id');
  if (error) throw error;
  return data || [];
}

async function loadData(ym) {
  const base = shiftYm(ym, -1);   // 직전 월 = 메이트 급여율 기준
  const [runR, usageTot, grades, roster, ftpay, per, sales] = await Promise.all([
    sb.from('sf_forecast_runs').select('ym,version,kind,daily,published_at').eq('ym', ym).eq('kind', '확정').order('version', { ascending: false }).limit(1),
    sb.rpc('material_usage_monthly_totals'),
    sb.from('ot_grades').select('grade,std_monthly_cost,allowance'),
    sb.from('ot_staff_roster').select('ym,store_code,grade,headcount').limit(5000),
    sb.from('ot_labor_monthly').select('store_code,ft_pay').eq('ym', ym).not('ft_pay', 'is', null),
    sb.from('ot_labor_periods').select('store_code,period_start,period_end,mate_pay').gte('period_start', base + '-01').lte('period_end', lastDay(base)).limit(2000),
    sb.from('ot_sales_daily').select('store_code,sales_date,total').gte('sales_date', base + '-01').lte('sales_date', lastDay(base)).limit(1000)
  ]);
  for (const r of [runR, usageTot, grades, roster, per, sales]) if (r.error) throw r.error;
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
    staff[c] = { nfull, fullpay, none: !!rYm && !R[rYm][c] };
  }

  // 메이트 급여율 = 직전 월 메이트 급여(급여대장) ÷ 그 기간 순매출
  const salesBy = {}; for (const r of sales.data || []) salesBy[r.store_code] = (salesBy[r.store_code] || 0) + (+r.total || 0);
  const payBy = {}; for (const r of per.data || []) payBy[r.store_code] = (payBy[r.store_code] || 0) + (+r.mate_pay || 0);
  const mateRate = {}; let pa = 0, ps = 0;
  for (const c of Object.keys(payBy)) { const net = (salesBy[c] || 0) / 1.1; if (net > 0) { mateRate[c] = payBy[c] / net; pa += payBy[c]; ps += net; } }
  const brandMateRate = ps ? pa / ps : null;

  return { run, ym, costYm, costRate, costSpan, brandCostRate, rYm, staff, base, mateRate, brandMateRate };
}

// 이력이 없는 매장(신규점)의 비율: 복제 원본 매장 → 없으면 브랜드 평균
function rateOf(map, code, brandAvg) {
  if (map[code] != null) return { v: map[code], src: 'own' };
  const cl = typeof CLONE_FROM !== 'undefined' && CLONE_FROM[code];
  if (cl && map[cl[0]] != null) return { v: map[cl[0]], src: 'clone', of: cl[0] };
  return { v: brandAvg || 0, src: 'avg' };
}

// ---------- 계산 ----------
// 매장별 말단 계정 값 (특이비용 제외)
function baseLeaf(code) {
  const D = S.D, st = D.run.daily.stores[code];
  const gross = st ? +st.total || 0 : 0, net = gross / 1.1;
  const cf = otCloseFrac(code, D.ym);
  const cr = rateOf(D.costRate, code, D.brandCostRate), mr = rateOf(D.mateRate, code, D.brandMateRate), sf = D.staff[code];
  const leaf = {
    gross_direct: gross,
    vat: gross - net,
    food: net * cr.v,
    food_tax: -net * FOOD_TAX_PCT,
    pay_ft: (sf.fullpay + sf.nfull * LC.LEAVE_PER_FT) * cf,
    retire: sf.nfull * LC.RETIRE_PER_FT * cf,
    pay_pt: net * mr.v
  };
  return { leaf, meta: { inRun: !!st, costSrc: cr, mateSrc: mr, noStaff: sf.none, closeFrac: cf } };
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

function adjLeaf(scope) {
  const out = {};
  for (const r of S.adj) if (r.scope === scope && PNL_BY[r.account_code]) out[r.account_code] = (out[r.account_code] || 0) + (+r.amount || 0);
  return out;
}
const addLeaf = (a, b) => { const o = { ...a }; for (const k of Object.keys(b)) o[k] = (o[k] || 0) + b[k]; return o; };

// 모든 열 값 계산: 매장별(특이 포함) · 매장합계 · 안분(데이터 대기) · 브랜드 특이
function computeAll() {
  const D = S.D, store = {}, metas = {};
  let sum = {};
  for (const c of STORES) {
    const b = baseLeaf(c); metas[c] = b.meta;
    const leaf = addLeaf(b.leaf, adjLeaf(c));
    store[c] = evalTree(leaf);
    sum = addLeaf(sum, leaf);
  }
  const total = evalTree(sum);
  const alloc = evalTree({ [PNL_ID.true_ded]: TRUE_NET_DED });   // 안분비 — 데이터를 받으면 채움 (지금은 진이익의 브랜드 차감만)
  const special = evalTree(adjLeaf('brand'));
  const brand = {};
  for (const a of PNL_ACC) brand[a.code] = total[a.code] + alloc[a.code] + special[a.code];
  return { store, total, alloc, special, brand, metas };
}

// ---------- 표시 ----------
const nf = v => { const r = Math.round(v); if (!r) return '<span class="z">-</span>'; return r < 0 ? '(' + Math.abs(r).toLocaleString('ko-KR') + ')' : r.toLocaleString('ko-KR'); };
const pf = (v, base) => (!base || !Math.round(v)) ? '' : (v / base * 100).toFixed(1) + '%';

function hasVisibleChild(a, mode) {
  if (mode === 'l1') return false;
  return a.children.some(c => mode === 'all' || PNL_BY[c].main);
}
// "대분류만" 보기 — 계정 트리의 1단계가 아니라 사용자가 정한 요약 줄들 (원가·인건비·제조경비는 매출원가의 (1-1)(1-2)(1-3))
const L1_ROWS = [
  ['sales', '매출액'], ['cogs.2', '원가'], ['cogs.3', '인건비'], ['cogs.4', '제조경비'], ['gp', '매출총이익'],
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
  $('plPickWrap').hidden = !(S.tab === 'store' && S.scope === 'one');
  if (!S.D) return;
  const C = computeAll();
  S.C = C;
  renderBrand(C); renderStore(C); renderNotes(C); renderAdjust();
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
  let h = `<table class="pnl" style="width:${W}px"><colgroup><col style="width:260px">${cols.map(() => '<col style="width:124px"><col style="width:64px">').join('')}</colgroup><thead><tr><th>로운 · ${S.ym.slice(0, 4)}년 ${+S.ym.slice(5)}월 예상</th>` +
    cols.map(([n]) => `<th class="num">${n}</th><th class="num">비율</th>`).join('') + '</tr></thead><tbody>';
  for (const a of visibleRows(S.mode)) {
    const ed = editable(a, S.mode);
    h += `<tr class="${rowCls(a)}">${labelCell(a, S.mode)}` + cols.map(([n, M]) => {
      const cell = ed && n === '특이비용';
      return `<td class="num${cell ? ' ed' : ''}"${cell ? ` data-ed="${a.code}" title="눌러서 직접 입력 (Enter 저장, Esc 취소)"` : ''}>${nf(M[a.code])}</td><td class="num r">${pf(M[a.code], M.sales)}</td>`;
    }).join('') + '</tr>';
  }
  $('brandTable').innerHTML = h + '</tbody></table>';
}

function renderStore(C) {
  const one = S.scope === 'one';
  if (!S.pick || !C.store[S.pick]) S.pick = STORES[0];
  const pickSel = $('plPick');
  if (pickSel.options.length !== STORES.length) pickSel.innerHTML = STORES.map(c => `<option value="${c}">${esc(sname(c))}</option>`).join('');
  pickSel.value = S.pick;
  const colsDef = one ? [[S.pick, sname(S.pick), S.pick, C.store[S.pick]]] : [['sum', '로운', '', C.total], ...STORES.map(c => [c, sname(c), c, C.store[c]])];
  const cw = one ? 160 : 112, pw = one ? 80 : 60;
  const W = 250 + colsDef.length * (cw + pw);
  let h = `<table class="pnl" style="width:${W}px"><colgroup><col style="width:250px">${colsDef.map(() => `<col style="width:${cw}px"><col style="width:${pw}px">`).join('')}</colgroup><thead>` +
    `<tr><th>매장코드</th>${colsDef.map(([, , code]) => `<th colspan="2" class="ctr">${code || '합계'}</th>`).join('')}</tr>` +
    `<tr><th>매장명</th>${colsDef.map(([, n]) => `<th colspan="2" class="ctr">${esc(n)}</th>`).join('')}</tr>` +
    `<tr><th>비고</th>${colsDef.map(() => '<th class="num">금액(원)</th><th class="num">비율</th>').join('')}</tr></thead><tbody>`;
  for (const a of visibleRows('main', true)) {
    h += `<tr class="${rowCls(a)}">${labelCell(a, 'main', a.id === 'op' ? 'op_ex' : null)}` + colsDef.map(([, , , M]) => `<td class="num">${nf(M[a.code])}</td><td class="num r">${pf(M[a.code], M.sales)}</td>`).join('') + '</tr>';
  }
  // 영업이익 밑: 브랜드 판관비·법인 판관비 (데이터 대기) — 영업이익 줄을 눌러 접고 펼친다 → 안분 후 영업이익
  if (!S.folded.has('op_ex')) {
    for (const n of ['브랜드 판관비', '법인 판관비']) h += `<tr class="l1 lf ex"><td class="nm" style="padding-left:20px"><span class="car"></span>${n} <span class="pend">데이터 대기</span></td>` + colsDef.map(() => '<td class="num"><span class="z">-</span></td><td class="num r"></td>').join('') + '</tr>';
  }
  h += `<tr class="l1 sub key"><td class="nm" style="padding-left:6px"><span class="car"></span>안분 후 영업이익</td>` + colsDef.map(([, , , M]) => `<td class="num">${nf(M.op)}</td><td class="num r">${pf(M.op, M.sales)}</td>`).join('') + '</tr>';
  $('storeTable').innerHTML = h + '</tbody></table>';
}

function renderNotes(C) {
  const D = S.D, r = D.run;
  const pub = r.published_at ? new Date(r.published_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const est = [];
  for (const c of STORES) {
    const m = C.metas[c];
    if (m.costSrc.src !== 'own') est.push(`${sname(c)} 원가율(${m.costSrc.src === 'clone' ? sname(m.costSrc.of) + ' 동일' : '브랜드 평균'})`);
    if (m.mateSrc.src !== 'own') est.push(`${sname(c)} 메이트 급여율(${m.mateSrc.src === 'clone' ? sname(m.mateSrc.of) + ' 동일' : '브랜드 평균'})`);
  }
  const noStaff = STORES.filter(c => C.metas[c].noStaff).map(sname);
  const li = [];
  li.push(`<b>외형매출·부가세</b> = 매출 앱 확정 예측 v${r.version}${pub ? ` (${pub} 발행)` : ''} — 폐점·신규 오픈 보정 반영. 매출액 = 외형매출 ÷ 1.1, 비율은 모두 매출액 대비.`);
  li.push(`<b>식재료원가</b> = ${D.costYm ? `${+D.costYm.slice(5)}월 누적 원가율(${D.costSpan ? D.costSpan.from.slice(5).replace('-', '/') + '~' + D.costSpan.to.slice(5).replace('-', '/') : ''}, 매장별 실적)` : '원가율 없음'} × 예상 매출액. <b>의제매입세액 공제</b> = 매출액의 −${(FOOD_TAX_PCT * 100).toFixed(1)}% (원본 손익표 기준 가정).`);
  li.push(`<b>급여_직원</b> = ${D.rYm ? `${+D.rYm.slice(5)}월 맨파워` : '8월 실측 구성'} × 직급 단가(+직책수당) + 연차수당(1인 ${(LC.LEAVE_PER_FT / 10000).toFixed(0)}만원)${noStaff.length ? ` · 맨파워 현황에 없는 매장은 정직원 0명: ${noStaff.join(', ')}` : ''}. <b>퇴직급여</b> = 정직원 1인 ${(LC.RETIRE_PER_FT / 10000).toFixed(0)}만원. 폐점·오픈 월은 영업 일수 비율로 줄입니다.`);
  li.push(`<b>급여_아르바이트</b> = ${+D.base.slice(5)}월 메이트 급여(급여대장) ÷ 순매출 비율 × 예상 매출액.`);
  if (est.length) li.push(`이력이 없어 대체한 값: ${est.join(' · ')}`);
  li.push(`<b>당기순이익</b> = 영업이익의 ${(NET_OF_OP * 100).toFixed(0)}% (법인세비용을 영업이익의 ${((1 - NET_OF_OP) * 100).toFixed(0)}%로 둔 추정). <b>진이익</b> = 당기순이익 − ${(TRUE_NET_DED / 1e6).toFixed(0)}백만원 (브랜드 차감, 추정 — 브랜드 탭의 안분비 열에 들어감).`);
  li.push('<b>비어 있는 계정</b>(제조경비·판관비·안분비 등)은 데이터를 받는 대로 채웁니다. 선임점장 급여의 본부 안분(50%)은 아직 반영하지 않았습니다.');
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
      rows.map(r => `<tr><td>${r.scope === 'brand' ? '브랜드(본부)' : esc(sname(r.scope))}</td><td>${esc(PNL_BY[r.account_code] ? pathLabel(PNL_BY[r.account_code]) : r.account_code)}</td><td class="num">${nf(r.amount)}</td><td>${esc(r.note || '')}</td><td><button class="btn btn-sm" data-del="${r.id}" type="button">삭제</button></td></tr>`).join('') +
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
