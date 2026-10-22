// 로운 수요 — 시장·경쟁사 모니터링 (1단계: 검색 지표 + 키워드·경쟁사 설정)
// 데이터는 서버(Edge Function demand-collect)가 수집해 DB에 저장하고, 이 화면은 저장된 표만 읽는다. 기획자 계정 전용(RLS).
// 월 검색수 = 네이버 검색광고 API(수집월 스냅샷, 쌓아서 추이를 만듦) / 과거 추이 = 네이버 데이터랩 상대지수를 실측 월에 맞춰 환산한 추정.

const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = n => n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('ko-KR');
const sgn = (v, d = 0) => (v >= 0 ? '+' : '') + v.toFixed(d);
const GRP_LABEL = { market: '시장', own: '우리', competitor: '경쟁사', need: '메뉴·니즈' };
const GRP_ORDER = ['market', 'own', 'competitor', 'need'];
const COLORS = ['#3F9E12', '#D9822B', '#378ADD', '#8E5BD1', '#D4537E', '#2F3030', '#1D9E75', '#BA7517'];
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } } };

let BRANDS = [], KW = [], SM = [], TR = [], RL = [], RUNS = [], VS = [], VR = [], VV = [], SC = [], EST = [], OWNM = [];
let KWMAP = new Map();
let chart = null;

async function fetchAll(table, cols, orderCol) {
  const acc = [];
  for (let i = 0; ; i++) {
    let q = sb.from(table).select(cols);
    if (orderCol) q = q.order(orderCol);
    const { data, error } = await q.range(i * 1000, i * 1000 + 999);
    if (error) throw error;
    acc.push(...data);
    if (data.length < 1000) break;
  }
  return acc;
}
async function loadAll() {
  [BRANDS, KW, SM, TR, RL, RUNS, VS, VR, VV, SC, EST, OWNM] = await Promise.all([
    fetchAll('demand_brands', '*', 'id'),
    fetchAll('demand_keywords', '*', 'id'),
    fetchAll('demand_search_monthly', '*', 'ym'),
    fetchAll('demand_trend', '*', 'period'),
    fetchAll('demand_related', '*', 'ym'),
    sb.from('demand_runs').select('*').order('id', { ascending: false }).limit(5).then(r => r.data || []),
    fetchAll('demand_voice_summary', '*', 'ym'),
    fetchAll('demand_voice_raw', 'brand_id,source,ym', 'id'),
    fetchAll('demand_voice_volume', '*', 'ym'),
    fetchAll('demand_store_counts', '*', 'period'),
    fetchAll('demand_estimates', '*', 'id'),
    sb.rpc('demand_own_monthly').then(r => r.data || [])
  ]);
  KWMAP = new Map(KW.map(k => [k.id, k]));
}

// ---------- 인증 ----------
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
  if (!isPlanner) {
    document.querySelectorAll('#dmNav button').forEach(b => { b.hidden = true; });
    document.querySelectorAll('.view').forEach(v => { v.hidden = true; });
    $('view-lock').hidden = false;
    return;
  }
  try { await loadAll(); } catch (e) { $('sumKpis').innerHTML = `<div style="grid-column:1/-1;color:var(--crit)">데이터 로드 실패: ${esc(e.message)}</div>`; showView('summary'); return; }
  restoreSel();
  renderAll();
  showView(window.navStart ? navStart('summary') : 'summary');
}
$('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.replace('../'); };

const VIEWS = ['summary', 'search', 'competitor', 'voice', 'source', 'settings'];
function showView(v) {
  if (!VIEWS.includes(v)) v = 'summary'; // 없어진 탭(예: 시장) 주소로 들어와도 요약으로
  document.querySelectorAll('#dmNav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  for (const k of VIEWS) $('view-' + k).hidden = k !== v;
  if (v === 'search') renderSearch();
  if (v === 'voice') renderVoice();
}
document.querySelectorAll('#dmNav button').forEach(b => { b.onclick = () => showView(b.dataset.view); });

function renderAll() { renderSummary(); renderSearch(); renderCompetitor(); renderVoice(); renderSource(); renderSettings(); if (window.renderReportBox) window.renderReportBox(); }

// ---------- 계산 도구 ----------
const pad2 = n => String(n).padStart(2, '0');
function ymList(n) {
  const d = new Date(); d.setDate(1);
  const out = [];
  for (let i = 0; i < n; i++) { out.unshift(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`); d.setMonth(d.getMonth() - 1); }
  return out;
}
const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${pad2(t % 12 + 1)}`; };
const devVal = (row, dev) => row ? (dev === 'pc' ? row.pc : dev === 'mobile' ? row.mobile : row.total) : null;

// 키워드 하나의 월별 값: 실측(검색광고 스냅샷)이 있으면 그것, 없으면 데이터랩 상대지수를 가장 최근 실측 월에 맞춰 환산한 추정
function seriesFor(kid, months, dev) {
  const act = new Map(SM.filter(r => r.keyword_id === kid).map(r => [r.ym, r]));
  const ratio = new Map(TR.filter(r => r.keyword_id === kid).map(r => [String(r.period).slice(0, 7), Number(r.ratio)]));
  // 환산 기준 = 표시 기간과 무관하게, 실측(검색광고)과 데이터랩 값이 모두 있는 가장 최근 월
  let scale = null;
  for (const m of [...act.keys()].sort().reverse()) {
    const a = devVal(act.get(m), dev), r = ratio.get(m);
    if (a > 0 && r > 0) { scale = a / r; break; }
  }
  return months.map(m => {
    const a = devVal(act.get(m), dev);
    if (a != null) return { v: a, actual: true };
    const r = ratio.get(m);
    return r != null && scale ? { v: r * scale, actual: false } : { v: null, actual: false };
  });
}
function latestActual(kid, dev) {
  const rows = SM.filter(r => r.keyword_id === kid && devVal(r, dev) != null).sort((a, b) => a.ym < b.ym ? -1 : 1);
  return rows.length ? { ym: rows[rows.length - 1].ym, v: devVal(rows[rows.length - 1], dev), prev: rows.length > 1 ? devVal(rows[rows.length - 2], dev) : null } : null;
}

// 급상승·신규 (연관어 최근 2개 수집월 비교)
function risingRelated() {
  const yms = [...new Set(RL.map(r => r.ym))].sort();
  if (!yms.length) return [];
  const cur = yms[yms.length - 1], prev = yms.length > 1 ? yms[yms.length - 2] : null;
  const prevMap = new Map(RL.filter(r => r.ym === prev).map(r => [r.keyword_id + '|' + r.related, r]));
  const out = [];
  for (const r of RL.filter(x => x.ym === cur)) {
    if ((r.total || 0) < 5000) continue;
    const p = prevMap.get(r.keyword_id + '|' + r.related);
    if (!prev) continue;
    if (!p) out.push({ kw: r.related, total: r.total, growth: null, isNew: true, base: KWMAP.get(r.keyword_id)?.keyword });
    else if (p.total > 0 && r.total / p.total - 1 >= 0.5) out.push({ kw: r.related, total: r.total, growth: r.total / p.total - 1, isNew: false, base: KWMAP.get(r.keyword_id)?.keyword });
  }
  return out.sort((a, b) => (b.growth ?? 9) - (a.growth ?? 9)).slice(0, 10);
}

// ---------- 요약 ----------
function lastCollectedYm() { const y = SM.map(r => r.ym).sort(); return y.length ? y[y.length - 1] : null; }
function renderSummary() {
  const act = KW.filter(k => k.active).length, comp = BRANDS.filter(b => b.kind === 'competitor' && b.status === 'active').length;
  const last = lastCollectedYm(), rises = risingRelated();
  $('sumKpis').innerHTML = `
    <div><div class="k">모니터링 키워드</div><div class="v">${act}개</div><div class="s">전체 ${KW.length}개 중 사용 중</div></div>
    <div><div class="k">경쟁사</div><div class="v">${comp}곳</div><div class="s">후보 ${BRANDS.filter(b => b.status === 'candidate').length}곳</div></div>
    <div><div class="k">최근 검색 수집</div><div class="v">${last || '대기'}</div><div class="s">${last ? '월 1회 갱신' : '키 등록 후 첫 수집'}</div></div>
    <div><div class="k">급상승·신규 키워드</div><div class="v">${last ? rises.length + '개' : '—'}</div><div class="s">전월 비교(두 달 이상 쌓인 뒤)</div></div>`;
  const st = (n, name, ready, note) => `<div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)"><span class="chip ${ready ? 'ok' : ''}">${n}단계</span><b style="min-width:150px">${name}</b><span style="color:var(--muted);font-size:12px">${note}</span></div>`;
  $('sumStages').innerHTML =
    st(1, '검색 지표', !!last, last ? '월 검색수·연관어·급상승 (매월 1일 자동 수집)' : '수집 대기') +
    st(2, '경쟁사 점포', true, '공정위 정보공개서 점포 수(연 단위) + 우리 점포·매출(내부 시스템). 가격 감시는 보류') +
    st(3, '고객 반응', true, '블로그·뉴스·유튜브 후기 수집 + AI 요약·부정 비중 (매월 1일 자동)') +
    st(4, '월간 리포트', true, '매월 2일 초안 자동 생성 → 기획자 검토·승인 → 게시, 엑셀 원자료');
}

// ---------- 검색 ----------
let SEL = [];
function restoreSel() {
  let saved = null;
  try { saved = JSON.parse(ls.get('dm_sel') || 'null'); } catch (e) { /* 무시 */ }
  const valid = (saved || []).filter(id => KWMAP.has(id));
  if (valid.length) SEL = valid;
  else SEL = ['샤브샤브', '훠궈', '스키야키', '로운샤브'].map(w => KW.find(k => k.keyword === w)?.id).filter(Boolean);
}
function saveSel() { ls.set('dm_sel', JSON.stringify(SEL)); }

function renderPickers() {
  const selKw = SEL.map(id => KWMAP.get(id)).filter(Boolean);
  const avail = KW.filter(k => !SEL.includes(k.id)).sort((a, b) => GRP_ORDER.indexOf(a.grp) - GRP_ORDER.indexOf(b.grp) || a.id - b.id);
  $('sPickers').innerHTML = selKw.map(k => `<span class="chipbtn on" data-rm="${k.id}" title="누르면 비교에서 뺍니다">${esc(k.keyword)} ×</span>`).join('') +
    (SEL.length < 8 ? `<select id="sAdd"><option value="">+ 키워드 추가</option>${avail.map(k => `<option value="${k.id}">${GRP_LABEL[k.grp]} · ${esc(k.keyword)}</option>`).join('')}</select>` : '');
  document.querySelectorAll('#sPickers [data-rm]').forEach(e => { e.onclick = () => { SEL = SEL.filter(i => i !== +e.dataset.rm); saveSel(); renderSearch(); }; });
  const add = $('sAdd'); if (add) add.onchange = () => { if (add.value) { SEL.push(+add.value); saveSel(); renderSearch(); } };
}

function renderSearch() {
  renderPickers();
  const n = +$('sPeriod').value, dev = $('sDevice').value;
  const months = ymList(n);
  const hasData = SM.length || TR.length;

  // KPI
  const find = w => KW.find(k => k.keyword === w);
  const mk = (kw, label) => {
    if (!kw) return `<div><div class="k">${label}</div><div class="v">—</div><div class="s">키워드 없음</div></div>`;
    const la = latestActual(kw.id, dev);
    if (!la) return `<div><div class="k">${esc(kw.keyword)} 월 검색수</div><div class="v">—</div><div class="s">수집 대기</div></div>`;
    const chg = la.prev > 0 ? (la.v / la.prev - 1) * 100 : null;
    const yoyM = shiftYm(la.ym, -12);
    const ser = seriesFor(kw.id, [yoyM], dev)[0];
    const yoy = ser && ser.v > 0 ? (la.v / ser.v - 1) * 100 : null;
    return `<div><div class="k">${esc(kw.keyword)} 월 검색수</div><div class="v">${num(la.v)}</div><div class="s">전월 ${chg == null ? '—' : `<span class="${chg >= 0 ? 'up' : 'dn'}">${sgn(chg)}%</span>`} · 전년 동월 ${yoy == null ? '—' : `<span class="${yoy >= 0 ? 'up' : 'dn'}">${sgn(yoy)}%</span>${ser.actual ? '' : '(추정)'}`} · ${la.ym}</div></div>`;
  };
  const rises = risingRelated();
  const own = find('로운샤브'), mkt = find('샤브샤브');
  const laOwn = own && latestActual(own.id, dev), laMkt = mkt && latestActual(mkt.id, dev);
  $('sKpis').innerHTML = mk(mkt, '시장') +
    (laOwn && laMkt && laMkt.v > 0 ? mk(own, '우리').replace('</div></div>', ` · 샤브샤브 대비 ${(laOwn.v / laMkt.v * 100).toFixed(1)}%</div></div>`) : mk(own, '우리')) +
    `<div><div class="k">급상승 키워드</div><div class="v">${rises.filter(r => !r.isNew).length}개</div><div class="s">전월 대비 +50% 이상</div></div>` +
    `<div><div class="k">신규 연관어</div><div class="v">${rises.filter(r => r.isNew).length}개</div><div class="s">이번 수집월에 새로 등장</div></div>`;

  // 차트
  if (chart) { chart.destroy(); chart = null; }
  const box = $('sChart').parentElement;
  if (!hasData || !SEL.length) {
    box.style.display = 'none';
    $('sChartNote').innerHTML = `<div class="empty">${hasData ? '위에서 비교할 키워드를 선택하세요.' : '아직 수집된 검색 데이터가 없습니다.<br>네이버 검색광고·데이터랩 키를 Supabase에 등록한 뒤 <b>지금 수집</b>을 누르면 이 자리에 추이가 나타납니다. (월 검색수는 수집한 달부터 쌓이고, 과거 구간은 데이터랩 추정으로 채워집니다.)'}</div>`;
  } else {
    box.style.display = '';
    const datasets = SEL.map((id, i) => {
      const ser = seriesFor(id, months, dev);
      const col = COLORS[i % COLORS.length];
      return {
        label: KWMAP.get(id).keyword, data: ser.map(s => s.v), borderColor: col, backgroundColor: col, borderWidth: 2.4, tension: 0, spanGaps: false,
        pointRadius: ser.map(s => s.v == null ? 0 : s.actual ? 4 : 2), pointBackgroundColor: ser.map(s => s.actual ? col : '#fff'), pointBorderColor: col,
        segment: { borderDash: c => (ser[c.p1DataIndex] && !ser[c.p1DataIndex].actual) ? [5, 4] : undefined }
      };
    });
    chart = new Chart($('sChart'), {
      type: 'line', data: { labels: months, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: { y: { beginAtZero: true, grid: { color: '#f0f0f0' }, ticks: { callback: v => v.toLocaleString('ko-KR') } } },
        plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 10 } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${num(c.raw)}` } } }
      }
    });
    $('sChartNote').textContent = '실선·채운 점 = 검색광고 API 실측(수집월 스냅샷) / 점선·빈 점 = 데이터랩 상대지수를 가장 최근 실측 월에 맞춰 환산한 추정값';
  }

  // 연관검색어
  const bases = KW.filter(k => RL.some(r => r.keyword_id === k.id));
  const sel = $('sRelBase'), keep = sel.value;
  sel.innerHTML = bases.length ? bases.map(k => `<option value="${k.id}">${esc(k.keyword)}</option>`).join('') : '<option value="">(데이터 없음)</option>';
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  renderRelated();
  sel.onchange = renderRelated;

  // 급상승
  $('sRiseTable').innerHTML = rises.length
    ? `<table><colgroup><col style="width:42%"><col style="width:20%"><col style="width:18%"><col style="width:20%"></colgroup><thead><tr><th class="l">키워드</th><th>월 검색수</th><th>전월 대비</th><th class="l">기준</th></tr></thead><tbody>` +
      rises.map(r => `<tr><td class="l">${esc(r.kw)} ${r.isNew ? '<span class="chip new">신규</span>' : ''}</td><td>${num(r.total)}</td><td>${r.growth == null ? '—' : `<span class="up">${sgn(r.growth * 100)}%</span>`}</td><td class="l">${esc(r.base || '')}</td></tr>`).join('') + '</tbody></table>'
    : '<div class="empty">두 달 이상 연관어가 쌓이면 급상승·신규 키워드가 표시됩니다.</div>';

  // 수집 이력
  const last = RUNS[0];
  $('sRunNote').textContent = last ? `최근 수집: ${String(last.started_at).slice(0, 16).replace('T', ' ')} · ${last.status === 'ok' ? '성공' : last.status === 'running' ? '진행 중' : '실패'}${last.message ? ' · ' + last.message : ''}` : '수집 이력이 없습니다.';
}
function renderRelated() {
  const kid = +$('sRelBase').value;
  const rows = RL.filter(r => r.keyword_id === kid);
  if (!rows.length) { $('sRelTable').innerHTML = '<div class="empty">연관어 데이터가 아직 없습니다.</div>'; return; }
  const yms = [...new Set(rows.map(r => r.ym))].sort();
  const cur = yms[yms.length - 1], prev = yms.length > 1 ? yms[yms.length - 2] : null;
  const prevMap = new Map(rows.filter(r => r.ym === prev).map(r => [r.related, r]));
  const list = rows.filter(r => r.ym === cur).sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 20);
  $('sRelTable').innerHTML = `<table><colgroup><col style="width:34%"><col style="width:20%"><col style="width:16%"><col style="width:16%"><col style="width:14%"></colgroup><thead><tr><th class="l">연관어 (${cur})</th><th>월 검색수</th><th>전월</th><th>순위</th><th>경쟁</th></tr></thead><tbody>` +
    list.map((r, i) => {
      const p = prevMap.get(r.related);
      const chg = p && p.total > 0 ? (r.total / p.total - 1) * 100 : null;
      const mv = p && p.rank != null && r.rank != null ? p.rank - r.rank : null;
      return `<tr><td class="l">${esc(r.related)} ${prev && !p ? '<span class="chip new">신규</span>' : ''}</td><td>${num(r.total)}</td><td>${chg == null ? '—' : `<span class="${chg >= 0 ? 'up' : 'dn'}">${sgn(chg)}%</span>`}</td><td>${r.rank ?? i + 1}${mv ? (mv > 0 ? ` <span class="up">▲${mv}</span>` : ` <span class="dn">▼${-mv}</span>`) : ''}</td><td>${esc(r.comp || '—')}</td></tr>`;
    }).join('') + '</tbody></table>';
}
$('sPeriod').onchange = renderSearch;
$('sDevice').onchange = renderSearch;

$('runCollectBtn').onclick = async () => {
  const msg = $('runMsg'); const btn = $('runCollectBtn');
  btn.disabled = true; msg.className = 'plan-msg'; msg.textContent = '수집 중… (키워드 수에 따라 1~2분)';
  try {
    const { data, error } = await sb.functions.invoke('demand-collect', { body: { mode: 'search' } });
    if (error) {
      // 서버가 보낸 실제 오류 문구를 꺼내 보여준다 (기본 문구는 'non-2xx status code'뿐)
      let m = error.message;
      try { if (error.context && error.context.json) { const j = await error.context.json(); if (j && j.error) m = j.error; } } catch (_) { /* 무시 */ }
      throw new Error(m);
    }
    if (data && data.error) throw new Error(data.error);
    msg.className = 'plan-msg ok'; msg.textContent = `수집 완료${data && data.summary ? ' · ' + data.summary : ''}`;
    await loadAll(); renderAll();
  } catch (e) {
    msg.className = 'plan-msg err';
    msg.textContent = /not found|404|FunctionsRelay|Failed to send/i.test(String(e.message)) ? '수집 기능이 아직 연결되지 않았습니다 (API 키 등록과 수집 함수 배포 후 사용 가능).' : '수집 실패: ' + e.message;
  } finally { btn.disabled = false; }
};

// ---------- 경쟁사 월별 추이 그래프 (2023~) ----------
// 우리: 내부 매출 시스템의 월별 매출·영업 점포 수(2024-01부터 있음).
// 경쟁사: 월별 값은 공개 자료가 없어, 알려진 시점의 값만 점으로 찍고 사이는 점선으로 잇는다.
//   점포 수 = 공정위 정보공개서(기준년도 전년 12월) + 기획자가 확정한 최신 확인값(기준월)
//   매출(추정) = 점포 수 × 확정한 점포당 평균 연매출 ÷ 12 — 점포 수와 평균 매출이 모두 확정된 브랜드만
const CH_START = '2023-01';
let chSales = null, chStores = null, CH_SEL = null;
function ymRange(from, to) { const out = []; for (let m = from; m <= to; m = shiftYm(m, 1)) out.push(m); return out; }
const curYm = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
// 브랜드 이름 키워드의 가장 최근 실측 월 검색수(경쟁사 상위 4곳 선정용)
function brandSearchNow(id) {
  let best = null;
  for (const k of KW.filter(x => x.brand_id === id && x.grp !== 'need')) { const la = latestActual(k.id, 'total'); if (la && (best == null || la.v > best)) best = la.v; }
  return best;
}
// 브랜드의 점포 수 알려진 시점들: { 'YYYY-MM': 값, ... }
function storePoints(b) {
  const pts = {};
  for (const r of SC.filter(r => r.brand_id === b.id && r.source === 'ftc' && r.area === '전체' && r.total > 0)) pts[`${Number(r.period) - 1}-12`] = r.total;
  for (const e of estOf(b.id, 'stores', 'confirmed').slice().reverse()) if (e.as_of) pts[String(e.as_of).slice(0, 7)] = Number(e.value);
  return pts;
}
// 추정 월 매출(억원): 점포 수 × 점포당 평균 연매출 ÷ 12, 확정된 평균 매출의 기준월에 점 하나씩
function salesPoints(b) {
  const sp = storePoints(b), keys = Object.keys(sp).sort(), pts = {};
  for (const e of estOf(b.id, 'avg_sales', 'confirmed')) {
    if (!e.as_of || !keys.length) continue;
    const m = String(e.as_of).slice(0, 7);
    const near = keys.reduce((a, k) => Math.abs(ymIdx(k) - ymIdx(m)) < Math.abs(ymIdx(a) - ymIdx(m)) ? k : a, keys[0]);
    if (Math.abs(ymIdx(near) - ymIdx(m)) <= 12) pts[m] = Number(e.value) * sp[near] / 12;
  }
  return pts;
}
const ymIdx = ym => { const [y, m] = ym.split('-').map(Number); return y * 12 + m; };
function renderCmpCharts() {
  if (!$('cmpChartSales') || typeof Chart === 'undefined') return;
  const own = BRANDS.find(b => b.kind === 'own' && b.status !== 'excluded');
  const comps = BRANDS.filter(b => b.kind === 'competitor' && b.status !== 'excluded');
  const ranked = comps.map(b => ({ b, v: brandSearchNow(b.id) })).sort((a, c) => (c.v || 0) - (a.v || 0));
  if (!CH_SEL) CH_SEL = ranked.slice(0, 4).map(x => x.b.id);
  $('chPick').innerHTML = ranked.map(({ b, v }) => `<label class="chip" style="cursor:pointer;margin:2px 4px 2px 0"><input type="checkbox" data-chpick="${b.id}"${CH_SEL.includes(b.id) ? ' checked' : ''}> ${esc(b.name)}${v ? ` <span class="dnote" style="display:inline">${num(v)}</span>` : ''}</label>`).join('');
  const months = ymRange(CH_START, curYm());
  const ownM = new Map((OWNM || []).map(r => [r.ym, r]));
  const sets = (kind) => {
    const out = [];
    if (own) {
      const data = months.map(m => { const r = ownM.get(m); return r ? (kind === 'sales' ? r.sales / 1e8 : r.stores) : null; });
      out.push({ label: own.name + ' (내부)', data, borderColor: COLORS[0], backgroundColor: COLORS[0], borderWidth: 3, pointRadius: 2, tension: 0.15, spanGaps: false });
    }
    CH_SEL.map(id => comps.find(b => b.id === id)).filter(Boolean).forEach((b, i) => {
      const pts = kind === 'sales' ? salesPoints(b) : storePoints(b);
      const data = months.map(m => pts[m] != null ? pts[m] : null);
      out.push({ label: b.name, data, borderColor: COLORS[(i + 1) % COLORS.length], backgroundColor: COLORS[(i + 1) % COLORS.length], borderWidth: 1.5, borderDash: [5, 4], pointRadius: 5, pointStyle: 'rectRot', spanGaps: true, tension: 0 });
    });
    return out;
  };
  const mk = (id, kind, prev, unit) => {
    if (prev) prev.destroy();
    return new Chart($(id), { type: 'line', data: { labels: months, datasets: sets(kind) }, options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y == null ? '—' : (kind === 'sales' ? c.parsed.y.toFixed(1) + '억' : num(c.parsed.y) + '개')}${kind === 'sales' && !c.dataset.label.includes('내부') ? ' (추정)' : ''}` } } },
      scales: { x: { ticks: { maxTicksLimit: 12, font: { size: 10 } } }, y: { beginAtZero: true, title: { display: true, text: unit, font: { size: 11 } } } } } });
  };
  chSales = mk('cmpChartSales', 'sales', chSales, '월 매출 (억원)');
  chStores = mk('cmpChartStores', 'stores', chStores, '점포 수 (개)');
  const part = (OWNM || []).find(r => r.partial);
  $('cmpChartNote').innerHTML = `우리(굵은 실선)는 내부 매출 시스템 월별 실적이며 <b>2024-01부터</b> 있습니다${part ? `(${part.ym}은 진행 중인 달이라 낮게 보임)` : ''}. 경쟁사(점선·마름모)는 월별 공개 자료가 없어 <b>알려진 시점의 값만</b> 표시합니다 — 점포 수는 공정위 정보공개서(전년도 12월)와 확정한 최신 확인값, 매출은 <b>확정한 점포 수 × 점포당 평균 연매출 ÷ 12 추정</b>이며 둘 다 확정된 브랜드만 나옵니다. 비교할 브랜드는 위 체크로 바꿀 수 있습니다(기본: 월 검색수 상위 4곳).`;
}
document.addEventListener('change', e => {
  const t = e.target.closest('[data-chpick]'); if (!t) return;
  const id = Number(t.dataset.chpick);
  CH_SEL = t.checked ? [...new Set([...(CH_SEL || []), id])] : (CH_SEL || []).filter(x => x !== id);
  renderCmpCharts();
});

// ---------- 경쟁사 ----------
// ---------- 경쟁사 ----------
// 공정위 API의 '기준년도'는 정보공개서 등록 연도라, 영업현황은 그 전년도 말 기준이다 (탕화쿵푸 2023→327, 2025→494가 언론의 2022·2024년 말 매장 수와 일치)
const ftcAsOf = y => `${Number(y) - 1}년 말`;
const EST_LABEL = { stores: '점포 수', avg_sales: '점포당 연매출', price: '가격' };
const EST_UNIT = { stores: '개', avg_sales: '억원', price: '원' };
const SRC_TYPE = { official: '공식', news: '언론', estimate: '추정', manual: '직접 확인' };
const estOf = (brandId, metric, status) => EST.filter(e => e.brand_id === brandId && e.metric === metric && e.status === status)
  .sort((a, b) => String(b.as_of || '').localeCompare(String(a.as_of || '')) || b.id - a.id);
const estFmt = e => e.metric === 'avg_sales' ? `${Number(e.value).toFixed(1)}억` : e.metric === 'price' ? `${num(e.value)}원` : `${num(e.value)}개`;
// 확정된 최신 확인값 한 칸: 값 + 출처 유형 + 기준일·출처 링크
function estCell(brandId, metric) {
  const c = estOf(brandId, metric, 'confirmed')[0], n = estOf(brandId, metric, 'candidate').length;
  if (c) {
    const link = c.source_url ? `<a href="${esc(c.source_url)}" target="_blank" rel="noopener noreferrer">출처</a>` : '출처 없음';
    return `<div style="font-weight:700">${estFmt(c)} <span class="chip ${c.source_type === 'official' ? 'ok' : ''}">${SRC_TYPE[c.source_type] || ''}</span></div><div class="dnote" style="margin:2px 0 0">${esc(c.as_of || '시점 미상')} 기준 · ${link}${c.note ? ' · ' + esc(c.note) : ''}${n ? ` · <span class="chip new">새 후보 ${n}</span>` : ''}</div>`;
  }
  return n ? `<span class="chip new">후보 ${n}건</span> <span class="dnote" style="display:inline">아래에서 확인</span>` : '<span style="color:var(--muted)">—</span>';
}
function renderCompetitor() {
  const rows = BRANDS.filter(b => b.status !== 'excluded').sort((a, b) => (a.kind === 'own' ? -1 : 1) - (b.kind === 'own' ? -1 : 1) || a.id - b.id);
  const latest = (id, src, area = '전체') => SC.filter(r => r.brand_id === id && r.source === src && r.area === area).sort((x, y) => String(y.period).localeCompare(String(x.period)));
  // 최신 확인값(점포 수): 우리는 내부 매출 시스템, 경쟁사는 확정한 값(출처·기준일 병기)
  const nowCell = b => {
    const own = latest(b.id, 'own')[0];
    if (own) return `<div style="font-weight:700">${num(own.total)}개 ${own.open_12m ? `<span class="up" style="font-weight:400">+${own.open_12m}</span>` : ''} <span class="chip ok">내부</span></div><div class="dnote" style="margin:2px 0 0">전 매장 직영 · 최근 12개월 신규 ${num(own.open_12m || 0)}개 (내부 매출 시스템 ${esc((own.note || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '')})</div>`;
    return estCell(b.id, 'stores');
  };
  // 공정위 정보공개서(연 단위, 전년도 말 영업현황): 가맹+직영, 이전 기준 대비 증감
  const ftcCell = b => {
    const rs = latest(b.id, 'ftc');
    if (b.kind === 'own') return '<span style="color:var(--muted)" title="정보공개서 미등록(전 매장 직영)">미등록</span>';
    if (rs.length) {
      const cur = rs[0], prev = rs.find(r => Number(r.period) < Number(cur.period) && r.total > 0);
      const chg = prev ? cur.total - prev.total : null;
      return `<div style="font-weight:700">${num(cur.total)}개 ${chg == null ? '' : `<span class="${chg >= 0 ? 'up' : 'dn'}" style="font-weight:400">${chg >= 0 ? '+' : ''}${chg}</span>`}</div><div class="dnote" style="margin:2px 0 0">가맹 ${num(cur.frcs)} · 직영 ${num(cur.dms)} (공정위 ${ftcAsOf(cur.period)} 기준)</div>`;
    }
    const sm = latest(b.id, 'semas')[0];
    if (sm && sm.total > 0) return `<div style="font-weight:700">${num(sm.total)}개 <span class="chip">참고</span></div><div class="dnote" style="margin:2px 0 0">상가정보 ${esc(String(sm.period).replace(/(\d{4})(\d{2})/, '$1-$2'))} 기준, 상호명으로 센 값(누락 가능)</div>`;
    return '<span style="color:var(--muted)" title="정보공개서에 등록되지 않았거나 이름이 달라 찾지 못했습니다">확인 불가</span>';
  };
  const salesCell = b => {
    const own = latest(b.id, 'own')[0];
    if (own && own.avg_sales_ttm) return `<div style="font-weight:700">${(own.avg_sales_ttm / 1e8).toFixed(1)}억 <span class="chip ok">내부</span></div><div class="dnote" style="margin:2px 0 0">최근 12개월, 12개월 이상 영업 점포 평균</div>`;
    return estCell(b.id, 'avg_sales');
  };
  $('cmpTable').innerHTML = `<table><colgroup><col style="width:150px"><col style="width:60px"><col style="width:130px"><col style="width:60px"><col style="width:100px"><col style="width:80px"><col style="width:230px"><col style="width:220px"><col style="width:200px"><col style="width:190px"></colgroup>
    <thead><tr><th class="l">브랜드</th><th>구분</th><th class="l">업태</th><th>상태</th><th>월 검색수(전체)</th><th>전월 대비</th><th class="l" title="언론·공식 자료에서 확인해 확정한 최신 점포 수(출처·기준일 병기). 우리는 내부 매출 시스템 값">점포 수<br><span style="font-weight:400">최신 확인값</span></th><th class="l" title="공정위 정보공개서 점포 수. 연 1회 갱신되며 영업현황은 등록 전년도 말 기준이라 최신과 차이가 큽니다">점포 수<br><span style="font-weight:400">공정위(전년도 말)</span></th><th class="l" title="우리는 내부 매출 시스템 기준(최근 12개월). 경쟁사는 확인한 값만 표시">점포당 연매출<br><span style="font-weight:400">확인값</span></th><th class="l" title="공식 홈페이지·메뉴판에서 확인해 입력한 대표 가격">가격<br><span style="font-weight:400">확인값</span></th></tr></thead><tbody>` +
    rows.map(b => {
      const kw = KW.find(k => k.brand_id === b.id && k.grp !== 'need');
      const la = kw ? latestActual(kw.id, 'total') : null;
      const chg = la && la.prev > 0 ? (la.v / la.prev - 1) * 100 : null;
      return `<tr><td class="l"><b>${esc(b.name)}</b></td><td>${b.kind === 'own' ? '<span class="chip ok">우리</span>' : '경쟁사'}</td><td class="l">${esc(b.segment || '')}</td><td>${b.status === 'candidate' ? '<span class="chip new">후보</span>' : '사용'}</td>` +
        `<td>${la ? num(la.v) : '—'}</td><td>${chg == null ? '—' : `<span class="${chg >= 0 ? 'up' : 'dn'}">${sgn(chg)}%</span>`}</td><td class="l" style="vertical-align:top">${nowCell(b)}</td><td class="l" style="vertical-align:top">${ftcCell(b)}</td><td class="l" style="vertical-align:top">${salesCell(b)}</td><td class="l" style="vertical-align:top">${estCell(b.id, 'price')}</td></tr>`;
    }).join('') + '</tbody></table>';
  renderEstPanel();
  renderCmpCharts();
}

// 후보 확인·직접 입력 패널
function estMsg(t, bad) { const e = $('estMsg'); if (!e) return; e.textContent = t; e.style.color = bad ? 'var(--crit)' : ''; }
function renderEstPanel() {
  if (!$('estCands')) return;
  const names = new Map(BRANDS.map(b => [b.id, b.name]));
  const byName = (a, b) => (names.get(a.brand_id) || '').localeCompare(names.get(b.brand_id) || '', 'ko') || String(b.as_of || '').localeCompare(String(a.as_of || ''));
  const cands = EST.filter(e => e.status === 'candidate').sort(byName);
  $('estCands').innerHTML = cands.length
    ? `<table><colgroup><col style="width:130px"><col style="width:90px"><col style="width:90px"><col style="width:100px"><col><col style="width:150px"></colgroup>
      <thead><tr><th class="l">브랜드</th><th>구분</th><th>값</th><th>기준일</th><th class="l">출처 · 인용(검증용)</th><th></th></tr></thead><tbody>` +
      cands.map(e => `<tr><td class="l"><b>${esc(names.get(e.brand_id) || '')}</b></td><td>${EST_LABEL[e.metric]}</td><td><b>${estFmt(e)}</b></td><td>${esc(e.as_of || '—')}</td>
        <td class="l" style="white-space:normal">${e.source_url ? `<a href="${esc(e.source_url)}" target="_blank" rel="noopener noreferrer">${esc(e.source_title || e.source_url)}</a>` : esc(e.source_title || '')}<div class="dnote" style="margin:2px 0 0">“${esc(e.quote || '')}”</div></td>
        <td><button class="btn btn-sm" data-est="ok" data-id="${e.id}" type="button">확정</button> <button class="btn btn-sm" data-est="no" data-id="${e.id}" type="button">제외</button></td></tr>`).join('') + '</tbody></table>'
    : '<div class="dnote" style="margin:0">확인 대기 중인 후보가 없습니다. “검색으로 후보 찾기”를 누르면 최신 기사에서 점포 수를 찾아 옵니다.</div>';
  const conf = EST.filter(e => e.status === 'confirmed').sort(byName);
  $('estConf').innerHTML = conf.length
    ? conf.map(e => `<span class="chip" style="margin:2px 4px 2px 0">${esc(names.get(e.brand_id) || '')} · ${EST_LABEL[e.metric]} ${estFmt(e)} (${esc(e.as_of || '시점 미상')}, ${SRC_TYPE[e.source_type] || ''}) <a href="#" data-est="undo" data-id="${e.id}" title="이 확정값을 취소">✕</a></span>`).join('')
    : '<span class="dnote" style="margin:0">아직 확정한 값이 없습니다.</span>';
  const sel = $('estBrand');
  if (sel && !sel.options.length) sel.innerHTML = BRANDS.filter(b => b.status !== 'excluded' && b.kind !== 'own').map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  if ($('estDate') && !$('estDate').value) $('estDate').value = new Date().toISOString().slice(0, 10);
  syncEstUnit();
}
function syncEstUnit() { const m = $('estMetric'); if (m && $('estUnit')) $('estUnit').textContent = EST_UNIT[m.value] || ''; }
async function reloadEst() { EST = await fetchAll('demand_estimates', '*', 'id'); renderCompetitor(); }
async function estSetStatus(id, status) {
  const { data: { session } } = await sb.auth.getSession();
  const { error } = await sb.from('demand_estimates').update({ status, confirmed_by: session?.user?.email || null, confirmed_at: new Date().toISOString() }).eq('id', id);
  if (error) { estMsg('저장 실패: ' + error.message, true); return; }
  await reloadEst();
  estMsg(status === 'confirmed' ? '확정했습니다.' : '반영했습니다.');
}
async function estAddManual() {
  const brand_id = Number($('estBrand').value), metric = $('estMetric').value, value = Number($('estValue').value);
  if (!brand_id || !(value > 0)) { estMsg('브랜드와 값을 입력하세요.', true); return; }
  const url = $('estUrl').value.trim();
  if (url && !/^https?:\/\//i.test(url)) { estMsg('출처 주소는 http(s)://로 시작해야 합니다.', true); return; }
  const { data: { session } } = await sb.auth.getSession();
  const note = $('estNote').value.trim().slice(0, 100);
  const row = { brand_id, metric, value, unit: EST_UNIT[metric], as_of: $('estDate').value || null, source_url: url || null, source_title: note || null, source_type: $('estType').value, note: note || null, status: 'confirmed', confirmed_by: session?.user?.email || null, confirmed_at: new Date().toISOString() };
  const { error } = await sb.from('demand_estimates').insert(row);
  if (error) { estMsg('저장 실패: ' + error.message, true); return; }
  $('estValue').value = ''; $('estUrl').value = ''; $('estNote').value = '';
  await reloadEst();
  estMsg('저장했습니다.');
}
async function runStoreSearch() {
  const btn = $('estSearchBtn'); btn.disabled = true;
  try {
    let offset = 0, saved = 0;
    for (let i = 0; i < 6; i++) {
      estMsg(`검색 중… (${offset + 1}번째 브랜드부터, 한 번에 4곳·약 1~2분)`);
      const r = await invokeFn('demand-storesearch', { offset });
      saved += r.saved || 0;
      if (r.note) estMsg(r.note, true);
      if (r.done) break;
      offset = r.next;
    }
    await reloadEst();
    estMsg(`완료: 새 후보 ${saved}건. 아래 목록에서 값과 출처를 확인하고 확정하세요.`);
  } catch (e) { estMsg('검색 실패: ' + (e.message || e), true); }
  btn.disabled = false;
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-est]'); if (!t) return;
  e.preventDefault();
  const id = Number(t.dataset.id);
  if (t.dataset.est === 'ok') estSetStatus(id, 'confirmed');
  else if (t.dataset.est === 'no') estSetStatus(id, 'rejected');
  else if (t.dataset.est === 'undo' && confirm('이 확정값을 취소할까요?')) estSetStatus(id, 'rejected');
});
$('estSearchBtn').onclick = runStoreSearch;
$('estAddBtn').onclick = estAddManual;
$('estMetric').onchange = syncEstUnit;

// ---------- 고객 반응 (3단계) ----------
const SRC_LABEL = { youtube_video: '유튜브 영상', youtube_comment: '유튜브 댓글', blog: '블로그', cafe: '카페', news: '뉴스' };
async function invokeFn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let m = error.message;
    try { if (error.context && error.context.json) { const j = await error.context.json(); if (j && j.error) m = j.error; } } catch (_) { /* 무시 */ }
    throw new Error(m);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}
const themeList = (arr, cls) => (arr && arr.length)
  ? arr.slice(0, 3).map(t => `<div><span class="${cls}">${esc(t.theme)}</span> <span style="color:var(--muted)">${num(t.count)}건</span>${t.example ? `<div class="dnote" style="margin:0">“${esc(t.example)}”</div>` : ''}</div>`).join('')
  : '<span style="color:var(--muted)">—</span>';
function renderVoice() {
  const yms = [...new Set([...VS.map(r => r.ym), ...VR.map(r => r.ym), ...VV.map(r => r.ym)])].sort().reverse();
  const sel = $('vMonth');
  const cur = sel.value && yms.includes(sel.value) ? sel.value : (yms[0] || '');
  sel.innerHTML = yms.length ? yms.map(m => `<option value="${m}"${m === cur ? ' selected' : ''}>${m}</option>`).join('') : '<option value="">(수집 전)</option>';
  const box = $('voiceTable');
  if (!cur) { box.innerHTML = '<div class="empty">아직 수집된 고객 반응이 없습니다. 오른쪽 위 <b>지금 수집·요약</b>을 누르면 이 자리에 브랜드별 요약이 나타납니다.</div>'; return; }
  const rawCnt = new Map();
  for (const r of VR) if (r.ym === cur) { const m = rawCnt.get(r.brand_id) || {}; m[r.source] = (m[r.source] || 0) + 1; rawCnt.set(r.brand_id, m); }
  const sumBy = new Map(VS.filter(r => r.ym === cur).map(r => [r.brand_id, r]));
  // 총 발행량 = 그 달 날짜가 있는 글(블로그+뉴스+유튜브 영상). 원문이 남아 있으면 그 건수, 이미 삭제됐으면 보관해 둔 건수 중 큰 값
  const DATED = ['blog', 'news', 'youtube_video'];
  const volSnap = new Map(VV.filter(r => r.ym === cur).map(r => [r.brand_id, r]));
  const volOf = id => {
    const rc = rawCnt.get(id) || {};
    const live = DATED.reduce((a, k) => a + (rc[k] || 0), 0);
    const sn = volSnap.get(id);
    // 수집 때 그 달 시작일까지 끝까지 내려가지 못했으면(날짜순 최대 1000건 한도) 실제는 더 많다는 뜻으로 '≥'를 붙인다
    return { n: Math.max(live, sn ? sn.total : 0), capped: sn ? sn.complete === false : false };
  };
  const vol = new Map(BRANDS.map(b => [b.id, volOf(b.id)]));
  // 고객 관심도 = 그 브랜드 이름의 월 검색수(네이버 검색광고 실측, 수집 전 달은 데이터랩 지수로 환산한 추정)
  const interest = new Map(BRANDS.map(b => {
    // 브랜드에 키워드가 여러 개면(예: '로운샤브', '로운 샤브샤브') 가장 많이 검색되는 쪽을 쓴다
    let best = null;
    for (const k of KW.filter(k => k.brand_id === b.id && k.grp !== 'need' && k.active)) {
      const p = seriesFor(k.id, [cur], 'total')[0];
      if (p && p.v != null && (!best || p.v > best.v)) best = p;
    }
    return [b.id, best];
  }));
  const maxInt = Math.max(1, ...[...interest.values()].map(p => p ? p.v : 0));
  const brands = BRANDS.filter(b => b.status !== 'excluded').sort((a, b) => ((interest.get(b.id) || { v: -1 }).v - (interest.get(a.id) || { v: -1 }).v) || (vol.get(b.id).n - vol.get(a.id).n) || a.id - b.id);
  const rankOf = new Map(brands.map((b, i) => [b.id, i + 1]));
  const shown = [...brands.filter(b => b.kind === 'own'), ...brands.filter(b => b.kind !== 'own')]; // 우리 브랜드 맨 위 고정(순위 숫자는 관심도 기준 그대로)
  const srcTxt = m => Object.entries(m || {}).map(([k, v]) => `${SRC_LABEL[k] || k} ${v}`).join(' · ') || '—';
  box.innerHTML = `<table><colgroup><col style="width:130px"><col style="width:130px"><col style="width:130px"><col style="width:170px"><col style="width:230px"><col style="width:260px"><col style="width:260px"><col style="width:230px"><col style="width:200px"></colgroup>
    <thead><tr><th class="l">브랜드</th><th class="l" title="브랜드 이름의 그 달 월 검색수(네이버 검색광고, PC+모바일). 클수록 고객이 많이 찾는 브랜드. 아래 작은 글씨는 수집한 후기·기사 수(표본)">고객 관심도<br><span style="font-weight:400">월 검색수</span></th><th class="l" title="AI가 훑어본 후기·기사(표본) 중 부정적인 의견이 담긴 항목의 비율. 일회성 불만도 포함해서 센 값">부정 비중<br><span style="font-weight:400">부정 의견 ÷ 탐색 콘텐츠</span></th><th class="l">표본(출처별)</th><th class="l">한 줄 요약</th><th class="l">좋다는 반응</th><th class="l">아쉽다는 반응</th><th class="l">자주 언급되는 특징</th><th class="l">주의 신호</th></tr></thead><tbody>` +
    shown.map(b => {
      const s = sumBy.get(b.id), rc = rawCnt.get(b.id);
      const n = s ? s.n_items : Object.values(rc || {}).reduce((a, c) => a + c, 0);
      const thin = n < 8 ? ' <span class="chip new">표본 부족</span>' : '';
      const nm = `<b>${esc(b.name)}</b>${b.kind === 'own' ? ' <span class="chip ok">우리</span>' : ''}`;
      const v = vol.get(b.id);
      // 부정 비중 = AI가 표본 항목을 하나씩 보고 센 '부정 의견이 담긴 항목' ÷ 탐색한(표본) 항목. 부정 항목 수가 아직 없는 옛 요약은 '—'
      const hasNeg = s && s.neg_items != null && s.sample_size > 0;
      const negPct = hasNeg ? s.neg_items / s.sample_size * 100 : null;
      const negCell = `<td class="l" style="vertical-align:top">${hasNeg ? `<div style="font-weight:700">${negPct.toFixed(1)}%</div><div class="dnote" style="margin:4px 0 0">${num(s.neg_items)}건 / ${num(s.sample_size)}건</div>` : '<span style="color:var(--muted)">—</span>'}</td>`;
      const it = interest.get(b.id);
      const vcell = `<td class="l" style="vertical-align:top"><div style="font-weight:700">${it ? num(it.v) : '—'}${it && !it.actual ? ' <span class="chip">추정</span>' : ''} <span style="color:var(--muted);font-weight:400">${it ? rankOf.get(b.id) + '위' : ''}</span></div>${it ? `<div style="height:5px;background:var(--fill);border-radius:3px;margin-top:4px"><div style="height:5px;width:${Math.max(2, Math.round(it.v / maxInt * 100))}%;background:${b.kind === 'own' ? '#3F9E12' : '#8a8a8a'};border-radius:3px"></div></div>` : ''}<div class="dnote" style="margin:4px 0 0">수집한 글 ${v.n ? (v.capped ? '≥ ' : '') + num(v.n) : 0}건</div></td>`;
      if (!s) return `<tr><td class="l" style="vertical-align:top">${nm}</td>${vcell}${negCell}<td class="l" style="white-space:normal;vertical-align:top">${esc(srcTxt(rc))}${thin}</td><td class="l" colspan="5" style="color:var(--muted);white-space:normal;vertical-align:top">${n ? '원문은 수집됐고 AI 요약 대기 중입니다 (요약 키 등록 후 <b>지금 수집·요약</b>).' : '수집된 원문이 없습니다.'}</td></tr>`;
      return `<tr><td class="l" style="vertical-align:top">${nm}</td>${vcell}${negCell}<td class="l" style="white-space:normal;vertical-align:top">${esc(srcTxt(s.sources))}${thin}</td>
        <td class="l" style="white-space:normal;vertical-align:top">${esc(s.headline || '')}</td>
        <td class="l" style="white-space:normal;vertical-align:top">${themeList(s.positives, 'dn')}</td>
        <td class="l" style="white-space:normal;vertical-align:top">${themeList(s.negatives, 'up')}</td>
        <td class="l" style="white-space:normal;vertical-align:top">${(s.features || []).length ? s.features.slice(0, 6).map(f => `<div>· ${esc(f)}</div>`).join('') : '<span style="color:var(--muted)">—</span>'}</td>
        <td class="l" style="white-space:normal;vertical-align:top">${(s.flags || []).length ? s.flags.map(f => `<div class="up">⚠ ${esc(f)}</div>`).join('') : '<span style="color:var(--muted)">없음</span>'}</td></tr>`;
    }).join('') + '</tbody></table>';
}
$('vMonth').onchange = renderVoice;
async function runVoice(mode) {
  const msg = $('vMsg'), b1 = $('runVoiceBtn'), b2 = $('runVoiceOnlyBtn');
  b1.disabled = b2.disabled = true; msg.className = 'plan-msg'; msg.textContent = mode === 'collect' ? '원문 수집 중… (1~2분)' : '수집·요약 중… (2~3분, 중복 클릭 금지)';
  try {
    let data = await invokeFn('demand-voice', { mode });
    // 요약은 호출 한도 때문에 한 번에 다 못 끝낼 수 있어, 남은 게 있으면 이어서 요청한다(최대 8회)
    for (let i = 1; data.remaining > 0 && i < 8; i++) {
      msg.textContent = `요약 이어서 진행 중… (남은 ${data.remaining}건, 창을 닫지 마세요)`;
      data = await invokeFn('demand-voice', { mode: 'summarize' });
    }
    msg.className = 'plan-msg ok'; msg.textContent = data.summary;
    await loadAll(); renderAll();
  } catch (e) { msg.className = 'plan-msg err'; msg.textContent = '실패: ' + e.message; }
  finally { b1.disabled = b2.disabled = false; }
}
$('runVoiceBtn').onclick = () => runVoice('all');
$('runVoiceOnlyBtn').onclick = () => runVoice('collect');

// ---------- 출처·한계 ----------
function renderSource() {
  const rows = [
    ['네이버 검색광고 API (키워드 도구)', '월 검색수(PC·모바일), 연관검색어, 경쟁 정도', '월 1회 스냅샷 적재', '과거 월별 값을 주지 않아 쌓은 시점부터 실측. 검색수가 매우 적으면 "<10"으로 가려져 비어 있음.'],
    ['네이버 데이터랩 (검색어트렌드)', '검색 관심도 추이(상대지수 0~100)', '월 1회 최근 24개월', '절대 검색수가 아닌 상대값 → 실측 월에 맞춰 환산한 추정으로만 표시(점선).'],
    ['(2단계) 카카오 지도 검색', '경쟁사 점포 수 월 스냅샷', '월 1회', '신규·폐점 판정은 근사치 — 후보로 두고 사람이 확인.'],
    ['네이버 블로그·카페·뉴스 검색 (NAVER API HUB)', '고객 반응, 신메뉴·프로모션 소식', '월 1회', '글이 발행된 달로 나눠 수집(날짜순 최대 500건, 제목·요약문만). 글이 매우 많은 브랜드는 월 전체가 아닌 표본이며 이름이 들어간 글만 사용. 광고성 글은 완전히 거르지 못함. 카페글은 작성일이 없어 수집 시점 최신글을 그 달로 간주.'],
    ['유튜브 (YouTube Data API v3)', '후기 영상, 인기 영상의 댓글', '월 1회', '그 달에 올라온 후기 영상과 조회수 상위 3개 영상의 댓글 20개씩(댓글은 작성일 기준). 원문은 정책에 따라 28일 후 자동 삭제하고 요약만 남김. 작성자 정보는 저장하지 않음.'],
    ['AI 요약 (Anthropic API)', '브랜드별 좋은 점·아쉬운 점·특징·주의 신호', '월 1회', '수집된 조각만 근거로 요약하며 표본이 8건 미만이면 "표본 부족"으로 표시. 기획자가 확인 후 활용.']
  ];
  $('srcTable').innerHTML = '<table><colgroup><col style="width:260px"><col style="width:280px"><col style="width:150px"><col></colgroup><thead><tr><th class="l">출처</th><th class="l">용도</th><th class="l">주기</th><th class="l">한계</th></tr></thead><tbody>' +
    rows.map(r => `<tr>${r.map(c => `<td class="l" style="white-space:normal">${esc(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
}

// ---------- 설정 (브랜드·키워드 관리) ----------
const KIND_OPT = [['competitor', '경쟁사'], ['own', '우리']];
const STATUS_OPT = [['active', '사용'], ['candidate', '후보'], ['excluded', '제외']];
const optHtml = (opts, cur) => opts.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('');
function renderSettings() {
  $('brandTable').innerHTML = `<table><colgroup><col style="width:190px"><col style="width:90px"><col style="width:170px"><col style="width:90px"><col style="width:260px"><col style="width:50px"></colgroup>
    <thead><tr><th class="l">브랜드명</th><th>구분</th><th class="l">업태</th><th>상태</th><th class="l">공식 홈페이지(가격·메뉴 확인용)</th><th></th></tr></thead><tbody>` +
    BRANDS.map(b => `<tr data-bid="${b.id}"><td><input class="cell-in" data-f="name" value="${esc(b.name)}"></td>
      <td><select class="cell-in" data-f="kind">${optHtml(KIND_OPT, b.kind)}</select></td>
      <td><input class="cell-in" data-f="segment" value="${esc(b.segment || '')}"></td>
      <td><select class="cell-in" data-f="status">${optHtml(STATUS_OPT, b.status)}</select></td>
      <td><input class="cell-in" data-f="official_url" value="${esc(b.official_url || '')}" placeholder="https://"></td>
      <td><button class="row-del" data-delb="${b.id}" title="삭제">×</button></td></tr>`).join('') + '</tbody></table>';
  $('kwTable').innerHTML = `<table><colgroup><col style="width:230px"><col style="width:110px"><col style="width:190px"><col style="width:70px"><col style="width:50px"></colgroup>
    <thead><tr><th class="l">키워드</th><th>구분</th><th class="l">연결 브랜드</th><th>사용</th><th></th></tr></thead><tbody>` +
    KW.slice().sort((a, b) => GRP_ORDER.indexOf(a.grp) - GRP_ORDER.indexOf(b.grp) || a.id - b.id).map(k => `<tr data-kid="${k.id}"><td><input class="cell-in" data-f="keyword" value="${esc(k.keyword)}"></td>
      <td><select class="cell-in" data-f="grp">${optHtml(GRP_ORDER.map(g => [g, GRP_LABEL[g]]), k.grp)}</select></td>
      <td><select class="cell-in" data-f="brand_id"><option value="">(없음)</option>${BRANDS.map(b => `<option value="${b.id}"${b.id === k.brand_id ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select></td>
      <td style="text-align:center"><input type="checkbox" data-f="active"${k.active ? ' checked' : ''}></td>
      <td><button class="row-del" data-delk="${k.id}" title="삭제">×</button></td></tr>`).join('') + '</tbody></table>';
}
async function updateRow(table, id, patch, msgEl) {
  const { error } = await sb.from(table).update(patch).eq('id', id);
  if (error) { alert('저장 실패: ' + error.message); return false; }
  return true;
}
document.addEventListener('change', async e => {
  const el = e.target; if (!el.dataset || !el.dataset.f) return;
  const trB = el.closest('tr[data-bid]'), trK = el.closest('tr[data-kid]');
  if (trB) {
    const id = +trB.dataset.bid; let v = el.value.trim();
    if (el.dataset.f === 'name' && !v) { renderSettings(); return; }
    if (!(await updateRow('demand_brands', id, { [el.dataset.f]: v || null }))) { await loadAll(); renderSettings(); return; }
    const b = BRANDS.find(x => x.id === id); b[el.dataset.f] = v || null; renderCompetitor(); renderSummary();
  } else if (trK) {
    const id = +trK.dataset.kid; let v = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (el.dataset.f === 'brand_id') v = v ? +v : null;
    if (el.dataset.f === 'keyword' && !v) { renderSettings(); return; }
    if (!(await updateRow('demand_keywords', id, { [el.dataset.f]: v }))) { await loadAll(); renderSettings(); return; }
    const k = KW.find(x => x.id === id); k[el.dataset.f] = v; KWMAP = new Map(KW.map(x => [x.id, x])); renderSummary(); renderCompetitor();
  }
});
document.addEventListener('click', async e => {
  const db = e.target.closest('[data-delb]'), dk = e.target.closest('[data-delk]');
  if (db) {
    const b = BRANDS.find(x => x.id === +db.dataset.delb);
    if (!b || !confirm(`"${b.name}" 브랜드를 삭제할까요?\n연결된 키워드는 남고 브랜드 연결만 해제됩니다.`)) return;
    const { error } = await sb.from('demand_brands').delete().eq('id', b.id);
    if (error) { alert('삭제 실패: ' + error.message); return; }
    await loadAll(); renderAll();
  } else if (dk) {
    const k = KW.find(x => x.id === +dk.dataset.delk);
    if (!k || !confirm(`"${k.keyword}" 키워드를 삭제할까요?\n이 키워드로 수집된 검색 데이터도 함께 삭제됩니다.`)) return;
    const { error } = await sb.from('demand_keywords').delete().eq('id', k.id);
    if (error) { alert('삭제 실패: ' + error.message); return; }
    SEL = SEL.filter(i => i !== k.id); saveSel();
    await loadAll(); renderAll();
  }
});
$('nbAdd').onclick = async () => {
  const name = $('nbName').value.trim(); const msg = $('nbMsg');
  if (!name) { msg.className = 'plan-msg err'; msg.textContent = '브랜드명을 입력하세요.'; return; }
  const { data, error } = await sb.from('demand_brands').insert({ name, kind: $('nbKind').value, segment: $('nbSeg').value.trim() || null }).select().single();
  if (error) { msg.className = 'plan-msg err'; msg.textContent = /duplicate|unique/i.test(error.message) ? '이미 있는 브랜드입니다.' : '추가 실패: ' + error.message; return; }
  // 브랜드명을 그대로 검색 키워드로도 등록 (경쟁사/우리)
  await sb.from('demand_keywords').insert({ keyword: name, grp: data.kind === 'own' ? 'own' : 'competitor', brand_id: data.id });
  $('nbName').value = ''; $('nbSeg').value = ''; msg.className = 'plan-msg ok'; msg.textContent = '추가했습니다 (같은 이름의 검색 키워드도 함께 등록).';
  await loadAll(); renderAll();
};
$('nkAdd').onclick = async () => {
  const keyword = $('nkWord').value.trim(); const msg = $('nkMsg');
  if (!keyword) { msg.className = 'plan-msg err'; msg.textContent = '키워드를 입력하세요.'; return; }
  const { error } = await sb.from('demand_keywords').insert({ keyword, grp: $('nkGrp').value });
  if (error) { msg.className = 'plan-msg err'; msg.textContent = /duplicate|unique/i.test(error.message) ? '이미 있는 키워드입니다.' : '추가 실패: ' + error.message; return; }
  $('nkWord').value = ''; msg.className = 'plan-msg ok'; msg.textContent = '추가했습니다 (다음 수집부터 반영).';
  await loadAll(); renderAll();
};

init();
