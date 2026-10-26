// 로운 공급 — 본부(법인 물류창고) 재고 + 핵심 자재 (S1). 매장 재고(material_usage)와 합산해 재고일수를 본다.
// 열람·업로드는 기획자 계정만 (hq_inventory RLS = ot_is_planner). 개인정보 없음.

// ---------- Supabase (통합 프로젝트) ----------
const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 큰 금액 표기: 1억 이상은 억, 아니면 만원
const eok = n => {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + '억';
  return Math.round(n / 1e4).toLocaleString('ko-KR') + '만';
};

const CAT_ORDER = ['정상자재', '출고부진', '평가감 대상', '평가감 반영중', '평가감 완료', '유통기한 내 소진불가'];

// ---------- 파서 ----------
// 머리글은 줄바꿈·공백이 섞여 있으므로 공백을 모두 지우고 비교한다.
const HQ_COLS = [
  ['center', h => h === '보관센터'],
  ['category', h => h.startsWith('자재구분')],
  ['main_use', h => h === '주사용'],
  ['material_code', h => h === '제품코드'],
  ['material_name', h => h === '자재명'],
  ['spec', h => h === '규격명'],
  ['stock_unit', h => h.startsWith('재고단위')],
  ['unit_cost', h => h.startsWith('원가')],
  ['out_6m', h => h.startsWith('6개월')],
  ['out_12m', h => h.startsWith('12개월')],
  ['stock_qty', h => h === '재고수량'],
  ['daily_out', h => h.startsWith('일평균출고')],
  ['stock_days', h => h === '재고일수'],
  ['stock_amount', h => h === '재고금액'],
  ['storage_fee', h => h === '보관비'],
  ['expiry_date', h => h === '유통기한'],
  ['snapshot_date', h => h === '오늘날짜'],
  ['shelf_days_left', h => h.startsWith('유통기한잔여')],
  ['gap_days', h => h.startsWith('유통기한재고일수')],
  ['unused_fee', h => h.startsWith('불용보관비')],
  ['brand_feedback', h => h.startsWith('브랜드피드백')],
  ['prev_category', h => h === '전주'],
  ['received_date', h => h === '입고일자'],
  ['stay_days', h => h === '체류일수']
];
const HQ_NUM = ['unit_cost', 'out_6m', 'out_12m', 'stock_qty', 'daily_out', 'stock_days', 'stock_amount', 'storage_fee', 'shelf_days_left', 'gap_days', 'unused_fee', 'stay_days'];
const HQ_DATE = ['expiry_date', 'received_date'];
const HQ_TEXT = ['center', 'category', 'main_use', 'material_code', 'material_name', 'spec', 'stock_unit', 'brand_feedback', 'prev_category'];

const pad2 = n => String(n).padStart(2, '0');
function toNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s]/g, '');
  if (s === '' || s === '-' || s[0] === '#') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}
function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;      // 엑셀 날짜 일련번호
    const d = new Date(Math.round((v - 25569) * 864e5));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  const m = String(v).trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  return m ? `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}` : null;
}
const toText = v => { const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); return s === '' || s === '#N/A' ? null : s; };

// 탭 구분 텍스트(엑셀 복사) → 2차원 배열. 따옴표로 감싼 셀 안의 줄바꿈을 보존한다.
function parseTsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"' && cur === '') q = true;
    else if (c === '\t') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// aoa → { rows, snapDates:{날짜:건수}, warn:[] }
function parseHq(aoa) {
  const norm = x => String(x == null ? '' : x).replace(/\s+/g, '');
  const hi = aoa.findIndex(r => r.some(c => norm(c) === '제품코드'));
  if (hi < 0) throw new Error("머리글 행('제품코드' 칸)을 찾지 못했습니다. 머리글까지 포함해 올려주세요.");
  const heads = aoa[hi].map(norm);
  const idx = {};
  for (const [key, test] of HQ_COLS) idx[key] = heads.findIndex(test);
  const need = ['center', 'material_code', 'stock_qty', 'snapshot_date'];
  const miss = need.filter(k => idx[k] < 0);
  if (miss.length) throw new Error('필수 칸을 찾지 못했습니다: ' + miss.join(', '));
  const rows = [], snapDates = {}, warn = [];
  for (let r = hi + 1; r < aoa.length; r++) {
    const src = aoa[r];
    const get = k => idx[k] < 0 ? '' : src[idx[k]];
    const code = String(get('material_code') == null ? '' : get('material_code')).replace(/\s+/g, '');
    const center = toText(get('center'));
    if (!/^\d+$/.test(code) || !center) continue;     // 빈 줄·꼬리 문구 제외
    const o = { material_code: code };
    for (const k of HQ_TEXT) if (k !== 'material_code') o[k] = toText(get(k));
    for (const k of HQ_NUM) o[k] = toNum(get(k));
    for (const k of HQ_DATE) o[k] = toDate(get(k));
    const sd = toDate(get('snapshot_date'));
    if (sd) snapDates[sd] = (snapDates[sd] || 0) + 1;
    // 유통기한이 없는 자재는 3000-12-31 같은 자리표시값이 오므로 유통기한 관련 칸을 비운다
    if (o.expiry_date && +o.expiry_date.slice(0, 4) >= 2999) { o.expiry_date = null; o.shelf_days_left = null; o.gap_days = null; }
    if (o.stock_qty == null) { warn.push(`${code} ${o.material_name || ''}: 재고수량이 비어 제외`); continue; }
    rows.push(o);
  }
  if (!rows.length) throw new Error('읽힌 데이터 행이 없습니다.');
  return { rows, snapDates, warn };
}

// ---------- 신호 / 집계 ----------
const isCoreCenter = c => /일죽/.test(c || '');
const isLivestock = c => /축산/.test(c || '');
const tierOfCenters = centers => centers.some(isCoreCenter) ? 1 : centers.some(isLivestock) ? 2 : 3;
const TIER_LABEL = { 1: '전략비축(일죽)', 2: '축산', 3: '일반' };

// 로트 1건의 신호: 'r' | 'y' | 'g' + 사유
const sigChip = lv => `<span class="sig ${lv}">${{ r: '위험', y: '주의', g: '정상' }[lv]}</span>`;

let LOTS = [];         // 이 기준일의 로트 행 (신호 포함)
let STORE_STOCK = new Map();   // material_code → { qty, unit, n, mismatch }
let STORE_PE = null;   // 매장 재고 기준 주차 마감일

// 자재코드 단위 집계 (센터·로트 합산)
function groupItems(lots) {
  const m = new Map();
  for (const l of lots) {
    let g = m.get(l.material_code);
    if (!g) { g = { code: l.material_code, name: l.material_name, spec: l.spec, unit: l.stock_unit, lots: [], centers: new Set(), cats: new Set() }; m.set(l.material_code, g); }
    g.lots.push(l); g.centers.add(l.center); if (l.category) g.cats.add(l.category);
  }
  const out = [];
  for (const g of m.values()) {
    g.tier = tierOfCenters([...g.centers]);
    g.qty = g.lots.reduce((t, l) => t + (l.stock_qty || 0), 0);
    g.amount = g.lots.reduce((t, l) => t + (l.stock_amount || 0), 0);
    g.daily = Math.max(0, ...g.lots.map(l => l.daily_out || 0));
    g.days = g.daily > 0 ? g.qty / g.daily : null;
    const ss = STORE_STOCK.get(g.code);
    g.store = ss && !ss.mismatch ? ss.qty : null;
    g.storeMismatch = !!(ss && ss.mismatch);
    // 매장재고(일) = 매장 재고 ÷ 매장 일평균 사용량(최근 4주). 합산 재고일수 = 비축일수 + 매장재고(일) — 매장 사용량을 알 수 없으면 비축일수만.
    g.storeDaily = ss && !ss.mismatch && STORE_SPAN_DAYS > 0 ? ss.usage / STORE_SPAN_DAYS : null;
    g.storeDays = g.store != null && g.storeDaily > 0 ? g.store / g.storeDaily : null;
    g.comb = g.days != null ? g.days + (g.storeDays || 0) : null;
    const exp = g.lots.filter(l => l.expiry_date).map(l => l.expiry_date).sort();
    g.expiry = exp[0] || null;
    const left = g.lots.filter(l => l.shelf_days_left != null).map(l => l.shelf_days_left);
    g.shelfMin = left.length ? Math.min(...left) : null;
    g.unusedFee = g.lots.reduce((t, l) => t + (l.unused_fee || 0), 0);
    // 신호: 로트 최악 + (핵심 자재만) 재고 부족
    let lv = 'g'; const why = [];
    for (const l of g.lots) { if (lvRank[l.sig.lv] < lvRank[lv]) lv = l.sig.lv; why.push(...l.sig.why); }
    if (g.tier <= 2 && g.comb != null) {
      if (g.comb < SIG.shortCritDays) { lv = 'r'; why.push(`합산 재고 ${num(g.comb, 1)}일뿐 — 부족`); }
      else if (g.comb < SIG.shortWarnDays && lv === 'g') { lv = 'y'; why.push(`합산 재고 ${num(g.comb, 1)}일 — 부족 주의`); }
    }
    g.sig = { lv, why: [...new Set(why)] };
    out.push(g);
  }
  return out;
}

// ---------- 데이터 로드 ----------
let SNAPS = [];         // [{snapshot_date, n, amount}]
async function loadSnaps() {
  const { data, error } = await sb.rpc('hq_inventory_snapshots');
  if (error) throw error;
  SNAPS = data || [];
}
async function loadLots(date) {
  const acc = [];
  for (let i = 0; ; i++) {
    const { data, error } = await sb.from('hq_inventory').select('*').eq('snapshot_date', date).order('id').range(i * 1000, i * 1000 + 999);
    if (error) throw error;
    acc.push(...data);
    if (data.length < 1000) break;
  }
  for (const l of acc) {
    for (const k of HQ_NUM) if (l[k] != null) l[k] = Number(l[k]);
    l.sig = lotSignal(l);
  }
  return acc;
}
// 매장 재고·사용량 — 재고는 가장 최근 주차 마감(period_end) 기준 전 매장 합, 사용량은 최근 4주(28일) 합 → 일평균 사용량.
// 같은 자재코드·같은 단위일 때만 합산한다.
let STORE_SPAN_DAYS = 0;   // 사용량을 합산한 기간의 일수
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
async function loadStoreStock(codes) {
  STORE_STOCK = new Map(); STORE_PE = null; STORE_SPAN_DAYS = 0;
  if (!codes.length) return;
  const { data: pe, error: e1 } = await sb.from('material_usage').select('period_end').order('period_end', { ascending: false }).limit(1);
  if (e1 || !pe || !pe.length) return;
  STORE_PE = pe[0].period_end;
  const d0 = new Date(STORE_PE + 'T00:00:00'); d0.setDate(d0.getDate() - 27);
  const fromEnd = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  let minStart = null;
  for (let i = 0; i < codes.length; i += 40) {
    const part = codes.slice(i, i + 40);
    for (let p = 0; ; p++) {
      const { data, error } = await sb.from('material_usage').select('store_code,material_code,stock_unit,current_stock_qty,actual_usage_qty,period_start,period_end').gte('period_end', fromEnd).lte('period_end', STORE_PE).in('material_code', part).range(p * 1000, p * 1000 + 999);
      if (error) throw error;
      for (const r of data) {
        const cur = STORE_STOCK.get(r.material_code) || { qty: 0, usage: 0, unit: r.stock_unit, n: 0, mismatch: false };
        if ((r.stock_unit || '').toLowerCase() !== (cur.unit || '').toLowerCase()) cur.mismatch = true;
        if (r.period_end === STORE_PE) { cur.qty += Number(r.current_stock_qty) || 0; cur.n++; }   // 재고 = 최근 주차 마감 시점
        cur.usage += Number(r.actual_usage_qty) || 0;                                             // 사용량 = 최근 4주 합
        if (r.period_start && (!minStart || r.period_start < minStart)) minStart = r.period_start;
        STORE_STOCK.set(r.material_code, cur);
      }
      if (data.length < 1000) break;
    }
  }
  STORE_SPAN_DAYS = minStart ? daysBetween(minStart, STORE_PE) + 1 : 0;
}

// ---------- 인증 (생산성·고객과 동일 — 로그인은 랜딩에서) ----------
let currentUser = null, isPlanner = false;

async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) enterApp(session.user); else location.replace('../');
}
async function enterApp(user) {
  currentUser = user;
  $('loginView').hidden = true; $('appView').hidden = false;
  $('whoEmail').textContent = user.email;
  let role = 'planner';
  try {
    const { data } = await sb.from('ot_profiles').select('role').eq('user_id', user.id).maybeSingle();
    if (data && data.role) role = data.role;
  } catch (e) { /* 무시 */ }
  isPlanner = role === 'planner';
  $('roleChip').textContent = isPlanner ? '기획자' : '매장 관리자';
  if (!isPlanner) {
    document.querySelectorAll('#spNav button').forEach(b => { b.hidden = true; });
    $('view-hq').hidden = true; $('view-upload').hidden = true; $('view-lock').hidden = false;
    return;
  }
  try {
    await loadSnaps();
  } catch (e) {
    $('hqKpis').innerHTML = `<div style="grid-column:1/-1;color:var(--crit)">데이터 로드 실패: ${esc(e.message)}</div>`;
    return;
  }
  buildSnapSelect();
  await renderHq();
  showView(window.navStart ? navStart('hq') : 'hq');
}
$('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.replace('../'); };

function showView(v) {
  document.querySelectorAll('#spNav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $('view-hq').hidden = v !== 'hq';
  $('view-upload').hidden = v !== 'upload';
  if (v === 'upload') renderLoadStat();
}
document.querySelectorAll('#spNav button').forEach(b => { b.onclick = () => showView(b.dataset.view); });

function buildSnapSelect() {
  const sel = $('hqSnap'), keep = sel.value;
  sel.innerHTML = SNAPS.length ? SNAPS.map(s => `<option value="${s.snapshot_date}">${s.snapshot_date}</option>`).join('') : '<option value="">자료 없음</option>';
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}
$('hqSnap').onchange = () => renderHq();

// ---------- 본부 재고 현황 ----------
let ITEMS = [];
async function renderHq() {
  const date = $('hqSnap').value;
  if (!date) {
    $('hqKpis').innerHTML = '<div style="grid-column:1/-1;color:var(--muted)">아직 올라온 본부 재고가 없습니다. <b>데이터 업로드</b> 탭에서 올려주세요.</div>';
    for (const id of ['coreTable', 'catTable', 'lotTable']) $(id).innerHTML = '';
    return;
  }
  $('hqSnapNote').textContent = '불러오는 중…';
  try {
    LOTS = await loadLots(date);
    await loadStoreStock([...new Set(LOTS.map(l => l.material_code))]);
  } catch (e) {
    $('hqKpis').innerHTML = `<div style="grid-column:1/-1;color:var(--crit)">데이터 로드 실패: ${esc(e.message)}</div>`;
    return;
  }
  ITEMS = groupItems(LOTS);
  $('hqSnapNote').textContent = `${LOTS.length}개 로트 · ${ITEMS.length}개 자재` + (STORE_PE ? ` · 매장 재고는 ${STORE_PE} 마감, 매장 사용량은 최근 4주 기준` : '');
  renderKpis(); renderCore(); renderCat(); buildLotFilters(); renderLots();
}

function renderKpis() {
  const tot = LOTS.reduce((t, l) => t + (l.stock_amount || 0), 0);
  const core1 = LOTS.filter(l => isCoreCenter(l.center)), core2 = LOTS.filter(l => !isCoreCenter(l.center) && isLivestock(l.center));
  const sum = a => a.reduce((t, l) => t + (l.stock_amount || 0), 0);
  // 위험 금액 = 유통기한·평가감·소진불가·불용 청구로 위험 판정된 로트 (재고 부족 신호는 제외)
  const risk = LOTS.filter(l => l.sig.lv === 'r');
  const slow = LOTS.filter(l => l.category && CAT_WARN(l.category));
  const fee = LOTS.reduce((t, l) => t + (l.unused_fee || 0), 0);
  const prev = SNAPS.find(s => s.snapshot_date < $('hqSnap').value);
  const dl = prev ? tot - Number(prev.amount) : null;
  $('hqKpis').innerHTML = `
    <div><div class="k">본부 총 재고금액</div><div class="v">${eok(tot)}</div><div class="s">${won(tot)}원${dl != null ? ` · 전주 대비 <b style="color:${dl > 0 ? 'var(--crit)' : 'var(--good)'}">${dl > 0 ? '+' : ''}${eok(dl)}</b>` : ''}</div></div>
    <div><div class="k">전략 비축(일죽)</div><div class="v">${eok(sum(core1))}</div><div class="s">${new Set(core1.map(l => l.material_code)).size}개 자재 · ${core1.length}로트</div></div>
    <div><div class="k">축산 비축(일죽 외)</div><div class="v">${eok(sum(core2))}</div><div class="s">${new Set(core2.map(l => l.material_code)).size}개 자재 · ${core2.length}로트</div></div>
    <div><div class="k">🚨 소진·불용 위험</div><div class="v" style="${risk.length ? 'color:var(--crit)' : ''}">${eok(sum(risk))}</div><div class="s">${risk.length}로트 (유통기한·평가감·청구)</div></div>
    <div><div class="k">불용 보관비 청구 예정</div><div class="v" style="${fee ? 'color:var(--crit)' : ''}">${won(fee)}원</div><div class="s">출고부진 재고 ${eok(sum(slow))} (${slow.length}로트)</div></div>`;
}

// 단위당 단가 = 재고금액 ÷ 재고수량 (자재 단위 기준, 로트 합계). 로트별 단가가 서로 다르면 평균이고 툴팁에 최소~최대를 보여준다.
function priceCell(g) {
  if (!(g.qty > 0) || g.amount == null) return '<span style="color:var(--muted2)">—</span>';
  const p = g.amount / g.qty, costs = g.lots.map(l => l.unit_cost).filter(v => v != null && v > 0);
  const lo = costs.length ? Math.min(...costs) : null, hi = costs.length ? Math.max(...costs) : null;
  const tip = lo != null && Math.round(lo) !== Math.round(hi) ? ` title="로트별 단가 ${won(lo)} ~ ${won(hi)}원 (평균 표시)"` : '';
  return `<span${tip}>${won(p)}원 <span style="font-size:11px;color:var(--muted2)">(${esc(g.unit || '')})</span></span>`;
}

function itemRows(items) {
  return items.map(g => {
    const storeTip = g.store == null ? '' : `매장 재고 ${num(g.store, g.store % 1 ? 1 : 0)}${g.unit || ''} · 일평균 사용 ${g.storeDaily != null ? num(g.storeDaily, 1) : '—'}${g.unit || ''}(최근 4주)`;
    const storeTxt = g.storeMismatch ? '<span title="매장과 재고단위가 달라 합산하지 않음">단위 상이</span>'
      : g.store == null ? '—'
      : g.storeDays == null ? `<span title="${esc(storeTip)}">사용 없음</span>`
      : `<span title="${esc(storeTip)}">${num(g.storeDays, 1)}</span>`;
    const gapTxt = g.shelfMin == null ? '—' : `<span class="${g.shelfMin < 0 ? 'neg' : ''}">${num(g.shelfMin)}일</span>`;
    return `<tr><td class="l"><span class="chip ${g.tier === 1 ? 't1' : g.tier === 2 ? 't2' : ''}">${TIER_LABEL[g.tier]}</span></td>
      <td class="l"><b>${esc(g.name)}</b><br><span style="font-size:11px;color:var(--muted2)">${esc(g.code)} · ${esc(g.spec || '')}</span></td>
      <td>${esc(g.unit || '')}</td><td>${num(g.qty, g.qty % 1 ? 1 : 0)}</td><td>${priceCell(g)}</td><td>${won(g.amount)}</td>
      <td>${g.daily ? `${num(g.daily, 1)} <span style="font-size:11px;color:var(--muted2)">${esc(g.unit || '')}</span>` : '—'}</td><td>${g.days == null ? '—' : num(g.days, 1)}</td>
      <td>${storeTxt}</td><td><b>${g.comb == null ? '—' : num(g.comb, 1)}</b></td>
      <td>${g.expiry || '—'}</td><td>${gapTxt}</td>
      <td>${sigChip(g.sig.lv)}</td><td class="why">${esc(g.sig.why.join(' · ')) || '—'}</td></tr>`;
  }).join('');
}
const ITEM_HEAD = `<colgroup><col style="width:100px"><col style="width:270px"><col style="width:44px"><col style="width:76px"><col style="width:112px"><col style="width:104px"><col style="width:100px"><col style="width:84px"><col style="width:84px"><col style="width:84px"><col style="width:96px"><col style="width:84px"><col style="width:60px"><col style="width:240px"></colgroup>
  <thead><tr><th>구분</th><th>자재</th><th>단위</th><th>본부 재고</th><th title="재고금액 ÷ 재고수량 — 자재 단위(kg·ea 등) 1개당 단가">단가(원)</th><th>재고금액(원)</th><th title="본부가 매장으로 하루 평균 내보내는 양 (자재 단위: kg·ea 등)">일 출고량</th><th title="본부 재고 ÷ 일 출고량 — 이 재고로 매장에 며칠 공급할 수 있는지">비축일수(일)</th><th title="매장 재고 ÷ 매장 일평균 사용량(최근 4주) — 매장이 가진 재고로 며칠 쓸 수 있는지">매장재고(일)</th><th title="비축일수 + 매장재고(일)">합산 재고일수</th><th>만료일(최단)</th><th title="가장 먼저 끝나는 로트의 유통기한까지 남은 일수">유통기한(일)</th><th>신호</th><th style="text-align:left">사유</th></tr></thead>`;

function renderCore() {
  const core = ITEMS.filter(g => g.tier <= 2).sort((a, b) => a.tier - b.tier || b.amount - a.amount);
  $('coreTable').innerHTML = core.length ? `<table>${ITEM_HEAD}<tbody>${itemRows(core)}</tbody></table>` : '<p class="dnote">이 기준일에는 일죽·축산 재고가 없습니다.</p>';
}

function renderCat() {
  const m = new Map();
  for (const l of LOTS) {
    const k = l.category || '(미분류)';
    const o = m.get(k) || { n: 0, items: new Set(), amount: 0, fee: 0 };
    o.n++; o.items.add(l.material_code); o.amount += l.stock_amount || 0; o.fee += l.unused_fee || 0;
    m.set(k, o);
  }
  const keys = [...m.keys()].sort((a, b) => (CAT_ORDER.indexOf(a) < 0 ? 99 : CAT_ORDER.indexOf(a)) - (CAT_ORDER.indexOf(b) < 0 ? 99 : CAT_ORDER.indexOf(b)));
  const tot = LOTS.reduce((t, l) => t + (l.stock_amount || 0), 0);
  let h = '<table><colgroup><col style="width:180px"><col style="width:80px"><col style="width:80px"><col style="width:130px"><col style="width:70px"><col style="width:150px"></colgroup><thead><tr><th>자재구분</th><th>로트</th><th>자재수</th><th>재고금액(원)</th><th>비중</th><th>불용 보관비 청구 예정(원)</th></tr></thead><tbody>';
  for (const k of keys) {
    const o = m.get(k);
    h += `<tr><td class="l ${CAT_CRIT(k) ? 'neg' : ''}">${esc(k)}</td><td>${o.n}</td><td>${o.items.size}</td><td>${won(o.amount)}</td><td>${tot ? Math.round(o.amount / tot * 100) + '%' : '—'}</td><td>${o.fee ? won(o.fee) : '—'}</td></tr>`;
  }
  h += `<tr style="background:var(--fill);font-weight:700"><td class="l">합계</td><td>${LOTS.length}</td><td>${ITEMS.length}</td><td>${won(tot)}</td><td>100%</td><td>${won(LOTS.reduce((t, l) => t + (l.unused_fee || 0), 0))}</td></tr></tbody></table>`;
  $('catTable').innerHTML = h;
}

function buildLotFilters() {
  const fill = (id, vals, all) => {
    const sel = $(id), keep = sel.value;
    sel.innerHTML = `<option value="">${all}</option>` + vals.map(v => `<option>${esc(v)}</option>`).join('');
    if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  };
  fill('fCenter', [...new Set(LOTS.map(l => l.center))].sort((a, b) => (isCoreCenter(b) - isCoreCenter(a)) || (isLivestock(b) - isLivestock(a)) || a.localeCompare(b)), '전체 센터');
  fill('fCat', [...new Set(LOTS.map(l => l.category || '(미분류)'))], '전체 구분');
}
for (const id of ['fCenter', 'fCat', 'fSig']) $(id).onchange = () => renderLots();
$('fQ').oninput = () => renderLots();

function renderLots() {
  const c = $('fCenter').value, cat = $('fCat').value, sg = $('fSig').value, q = $('fQ').value.trim().toLowerCase();
  let rows = LOTS.filter(l => (!c || l.center === c) && (!cat || (l.category || '(미분류)') === cat)
    && (!sg || (sg === 'r' ? l.sig.lv === 'r' : l.sig.lv !== 'g'))
    && (!q || (l.material_name || '').toLowerCase().includes(q) || l.material_code.includes(q)));
  const tier = l => isCoreCenter(l.center) ? 1 : isLivestock(l.center) ? 2 : 3;
  rows = rows.sort((a, b) => lvRank[a.sig.lv] - lvRank[b.sig.lv] || tier(a) - tier(b) || (b.stock_amount || 0) - (a.stock_amount || 0));
  $('lotCount').textContent = `${rows.length}건 · ${won(rows.reduce((t, l) => t + (l.stock_amount || 0), 0))}원`;
  let h = `<table><colgroup><col style="width:60px"><col style="width:150px"><col style="width:130px"><col style="width:290px"><col style="width:46px"><col style="width:76px"><col style="width:110px"><col style="width:72px"><col style="width:70px"><col style="width:96px"><col style="width:64px"><col style="width:70px"><col style="width:96px"><col style="width:60px"><col style="width:96px"><col style="width:110px"></colgroup>
    <thead><tr><th>신호</th><th>보관센터</th><th>자재구분</th><th>자재</th><th>단위</th><th>재고수량</th><th>재고금액(원)</th><th title="본부가 매장으로 하루 평균 내보내는 양 (단위 열 기준)">일 출고량</th><th title="이 로트 수량 ÷ 일 출고량">비축일수(일)</th><th>만료일</th><th title="유통기한까지 남은 일수">유통기한(일)</th><th>소진차이</th><th>불용 청구(원)</th><th>입고일</th><th>체류일</th><th>전주 구분</th></tr></thead><tbody>`;
  for (const l of rows) {
    const worse = l.prev_category && l.prev_category !== l.category && /정상/.test(l.prev_category) && !/정상/.test(l.category || '');
    h += `<tr><td>${sigChip(l.sig.lv)}</td><td class="l">${esc(l.center)}</td><td class="l ${CAT_CRIT(l.category) ? 'neg' : ''}">${esc(l.category || '')}</td>
      <td class="l"><b>${esc(l.material_name)}</b><br><span style="font-size:11px;color:var(--muted2)">${esc(l.material_code)}</span></td>
      <td>${esc(l.stock_unit || '')}</td><td>${num(l.stock_qty, l.stock_qty % 1 ? 1 : 0)}</td><td>${won(l.stock_amount)}</td>
      <td>${l.daily_out ? num(l.daily_out, 1) : '—'}</td><td>${l.stock_days == null ? '—' : num(l.stock_days, 1)}</td>
      <td>${l.expiry_date || '—'}</td><td class="${l.shelf_days_left != null && l.shelf_days_left < 0 ? 'neg' : ''}">${l.shelf_days_left == null ? '—' : num(l.shelf_days_left)}</td>
      <td class="${l.gap_days != null && l.gap_days < 0 ? 'neg' : ''}">${l.gap_days == null ? '—' : num(l.gap_days)}</td>
      <td>${l.unused_fee ? won(l.unused_fee) : '—'}</td><td>${l.received_date ? l.received_date.slice(5) : '—'}</td><td>${l.stay_days == null ? '—' : num(l.stay_days)}</td>
      <td class="l">${l.prev_category ? (worse ? `<b class="neg">${esc(l.prev_category)} ▶ 악화</b>` : esc(l.prev_category)) : '—'}</td></tr>`;
  }
  h += '</tbody></table>';
  $('lotTable').innerHTML = rows.length ? h : '<p class="dnote">조건에 맞는 재고가 없습니다.</p>';
}

const stamp = () => exDateStamp();
$('coreExportBtn').onclick = () => downloadTablesAsExcel('#coreTable', `핵심자재_${$('hqSnap').value}`);
$('catExportBtn').onclick = () => downloadTablesAsExcel('#catTable', `자재구분별요약_${$('hqSnap').value}`);
$('lotExportBtn').onclick = () => downloadTablesAsExcel('#lotTable', `본부재고_로트_${$('hqSnap').value}`);

// ---------- 업로드 ----------
let PENDING = null;   // { rows, snapDates }

function setMsg(el, text, cls) { el.textContent = text; el.className = 'plan-msg' + (cls ? ' ' + cls : ''); }

async function handleAoa(aoa) {
  const msg = $('hqMsg');
  try {
    const res = parseHq(aoa);
    PENDING = res;
    const dates = Object.entries(res.snapDates).sort((a, b) => b[1] - a[1]);
    const snap = dates.length ? dates[0][0] : '';
    $('hqSnapDate').value = snap;
    renderPreview(res, dates);
    $('hqPreviewCard').hidden = false;
    setMsg(msg, `${res.rows.length}행을 읽었습니다. 아래 미리보기를 확인하고 저장하세요.` + (res.warn.length ? ` (제외 ${res.warn.length}건)` : ''), 'ok');
    $('hqSaveMsg').textContent = '';
  } catch (e) {
    PENDING = null; $('hqPreviewCard').hidden = true;
    setMsg(msg, e.message, 'err');
  }
}

function renderPreview(res, dates) {
  const m = new Map();
  for (const r of res.rows) {
    const o = m.get(r.center) || { n: 0, amount: 0 };
    o.n++; o.amount += r.stock_amount || 0; m.set(r.center, o);
  }
  const tot = res.rows.reduce((t, r) => t + (r.stock_amount || 0), 0);
  let h = '<table><colgroup><col style="width:220px"><col style="width:80px"><col style="width:140px"></colgroup><thead><tr><th>보관센터</th><th>행</th><th>재고금액(원)</th></tr></thead><tbody>';
  for (const [k, o] of [...m.entries()].sort((a, b) => b[1].amount - a[1].amount)) h += `<tr><td class="l">${esc(k)}${isCoreCenter(k) ? ' <span class="chip t1">전략</span>' : ''}</td><td>${o.n}</td><td>${won(o.amount)}</td></tr>`;
  h += `<tr style="background:var(--fill);font-weight:700"><td class="l">합계</td><td>${res.rows.length}</td><td>${won(tot)}</td></tr></tbody></table>`;
  if (dates.length > 1) h += `<p class="dnote neg">'오늘날짜' 칸에 날짜가 여러 개입니다(${dates.map(d => d[0] + ' ' + d[1] + '행').join(', ')}). 가장 많은 날짜를 기준일로 넣었으니 확인하세요.</p>`;
  if (res.warn.length) h += `<p class="dnote">제외된 행: ${esc(res.warn.slice(0, 5).join(' / '))}${res.warn.length > 5 ? ' …' : ''}</p>`;
  $('hqPreview').innerHTML = h;
}

$('hqFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  setMsg($('hqMsg'), '읽는 중…');
  try {
    let aoa;
    if (/\.(csv|tsv|txt)$/i.test(f.name)) {
      const t = await f.text();
      aoa = parseTsv(t.includes('\t') ? t : t.replace(/,/g, '\t'));
    } else {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      // 머리글('제품코드')이 있는 첫 시트를 쓴다
      let pick = null;
      for (const name of wb.SheetNames) {
        const a = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
        if (a.some(r => r.some(c => String(c).replace(/\s+/g, '') === '제품코드'))) { pick = a; break; }
      }
      if (!pick) throw new Error("'제품코드' 머리글이 있는 시트를 찾지 못했습니다.");
      aoa = pick;
    }
    await handleAoa(aoa);
  } catch (err) { setMsg($('hqMsg'), err.message, 'err'); }
};
$('hqParseBtn').onclick = () => {
  const t = $('hqPaste').value;
  if (!t.trim()) { setMsg($('hqMsg'), '붙여넣은 내용이 없습니다.', 'err'); return; }
  handleAoa(parseTsv(t));
};

$('hqSave').onclick = async () => {
  if (!PENDING) return;
  const date = $('hqSnapDate').value;
  const msg = $('hqSaveMsg');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setMsg(msg, '기준일을 입력하세요.', 'err'); return; }
  const exists = SNAPS.find(s => s.snapshot_date === date);
  if (exists && !confirm(`${date} 기준 자료가 이미 ${exists.n}행 있습니다. 새 파일(${PENDING.rows.length}행)로 교체할까요?`)) return;
  $('hqSave').disabled = true; setMsg(msg, '저장 중…');
  try {
    const payload = PENDING.rows.map(({ snapshot_date, ...r }) => r);
    const { data, error } = await sb.rpc('hq_inventory_replace', { p_date: date, p_rows: payload });
    if (error) throw error;
    setMsg(msg, `${data}행 저장 완료 (${date})`, 'ok');
    PENDING = null;
    await loadSnaps(); buildSnapSelect(); $('hqSnap').value = date;
    renderLoadStat();
    await renderHq();
  } catch (err) {
    setMsg(msg, '저장 실패: ' + err.message, 'err');
  } finally { $('hqSave').disabled = false; }
};

function renderLoadStat() {
  if (!SNAPS.length) { $('hqLoadStat').innerHTML = '<p class="dnote">아직 올라온 자료가 없습니다.</p>'; return; }
  let h = '<table><colgroup><col style="width:130px"><col style="width:80px"><col style="width:150px"></colgroup><thead><tr><th>기준일</th><th>행</th><th>재고금액(원)</th></tr></thead><tbody>';
  for (const s of SNAPS) h += `<tr><td class="l">${s.snapshot_date}</td><td>${s.n}</td><td>${won(Number(s.amount))}</td></tr>`;
  $('hqLoadStat').innerHTML = h + '</tbody></table>';
}

init();
