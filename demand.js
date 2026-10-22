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

let BRANDS = [], KW = [], SM = [], TR = [], RL = [], RUNS = [], VS = [], VR = [], VV = [], SC = [];
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
  [BRANDS, KW, SM, TR, RL, RUNS, VS, VR, VV, SC] = await Promise.all([
    fetchAll('demand_brands', '*', 'id'),
    fetchAll('demand_keywords', '*', 'id'),
    fetchAll('demand_search_monthly', '*', 'ym'),
    fetchAll('demand_trend', '*', 'period'),
    fetchAll('demand_related', '*', 'ym'),
    sb.from('demand_runs').select('*').order('id', { ascending: false }).limit(5).then(r => r.data || []),
    fetchAll('demand_voice_summary', '*', 'ym'),
    fetchAll('demand_voice_raw', 'brand_id,source,ym', 'id'),
    fetchAll('demand_voice_volume', '*', 'ym'),
    fetchAll('demand_store_counts', '*', 'period')
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

const VIEWS = ['summary', 'market', 'search', 'competitor', 'voice', 'source', 'settings'];
function showView(v) {
  document.querySelectorAll('#dmNav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  for (const k of VIEWS) $('view-' + k).hidden = k !== v;
  if (v === 'search') renderSearch();
  if (v === 'voice') renderVoice();
}
document.querySelectorAll('#dmNav button').forEach(b => { b.onclick = () => showView(b.dataset.view); });

function renderAll() { renderSummary(); renderSearch(); renderCompetitor(); renderVoice(); renderSource(); renderSettings(); }

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
    st(1, '검색 지표', !!last, last ? '월 검색수·연관어·급상승 (수집 중)' : '화면·DB 준비 완료 — 검색광고·데이터랩 키 등록 후 수집') +
    st(2, '경쟁사 점포·가격', false, '카카오 지도 점포 수 월 스냅샷, 공식 가격 페이지 변경 감지, 신규 후보 발굴') +
    st(3, '고객 반응', false, '블로그·카페·유튜브 후기 수집 + AI 요약') +
    st(4, '월간 리포트', false, '자동 생성 → 기획자 검토·승인 → 게시, 엑셀 원자료, 홈 카드');
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

// ---------- 경쟁사 ----------
function renderCompetitor() {
  const rows = BRANDS.filter(b => b.status !== 'excluded').sort((a, b) => (a.kind === 'own' ? -1 : 1) - (b.kind === 'own' ? -1 : 1) || a.id - b.id);
  // 점포 수: 공정위 정보공개서 기준(기준년도별, 가맹점+직영점). 브랜드관리번호가 없는 브랜드는 아직 값이 없다.
  const latest = (id, src, area = '전체') => SC.filter(r => r.brand_id === id && r.source === src && r.area === area).sort((x, y) => String(y.period).localeCompare(String(x.period)));
  const storeCell = b => {
    // 1) 우리 브랜드: 내부 매출 시스템(전 매장 직영)
    const own = latest(b.id, 'own')[0];
    if (own) return `<div style="font-weight:700">${num(own.total)}개 ${own.open_12m ? `<span class="up" style="font-weight:400">+${own.open_12m}</span>` : ''}</div><div class="dnote" style="margin:2px 0 0">전 매장 직영 · 최근 12개월 신규 ${num(own.open_12m || 0)}개 (내부 매출 시스템 ${esc((own.note || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '')})</div>`;
    // 2) 공정위 정보공개서(연 단위): 가맹+직영, 전 기준년도 대비 증감
    const rows = latest(b.id, 'ftc');
    if (rows.length) {
      const cur = rows[0], prev = rows.find(r => Number(r.period) < Number(cur.period));
      const chg = prev ? cur.total - prev.total : null;
      return `<div style="font-weight:700">${num(cur.total)}개 ${chg == null ? '' : `<span class="${chg >= 0 ? 'up' : 'dn'}" style="font-weight:400">${chg >= 0 ? '+' : ''}${chg}</span>`}</div><div class="dnote" style="margin:2px 0 0">가맹 ${num(cur.frcs)} · 직영 ${num(cur.dms)} (정보공개서 ${cur.period} 기준)</div>`;
    }
    // 3) 공정위에 없으면 소상공인 상가정보에서 상호명으로 센 값(참고용: 업종 분류·상호 표기에 따라 빠질 수 있음)
    const sm = latest(b.id, 'semas')[0];
    if (sm && sm.total > 0) return `<div style="font-weight:700">${num(sm.total)}개 <span class="chip">참고</span></div><div class="dnote" style="margin:2px 0 0">상가정보 ${esc(String(sm.period).replace(/(\d{4})(\d{2})/, '$1-$2'))} 기준, 상호명으로 센 값(누락 가능)</div>`;
    return b.ftc_brand_no ? '<span style="color:var(--muted)">자료 없음</span>' : '<span style="color:var(--muted)" title="정보공개서에 등록되지 않았거나 이름이 달라 찾지 못했고, 상가정보에서도 상호명으로 찾지 못했습니다">확인 불가</span>';
  };
  // 점포당 연매출: 우리는 내부 매출 시스템 값, 경쟁사는 공개 자료가 없어 비워 둔다
  const salesCell = b => {
    const own = latest(b.id, 'own')[0];
    if (own && own.avg_sales_ttm) return `<div style="font-weight:700">${(own.avg_sales_ttm / 1e8).toFixed(1)}억</div><div class="dnote" style="margin:2px 0 0">최근 12개월, 12개월 이상 영업 점포 평균</div>`;
    return '<span style="color:var(--muted)" title="경쟁사 점포당 매출은 공개 API가 없어 비워 둡니다">—</span>';
  };
  $('cmpTable').innerHTML = `<table><colgroup><col style="width:180px"><col style="width:70px"><col style="width:170px"><col style="width:90px"><col style="width:130px"><col style="width:110px"><col style="width:200px"><col style="width:150px"><col style="width:110px"></colgroup>
    <thead><tr><th class="l">브랜드</th><th>구분</th><th class="l">업태</th><th>상태</th><th>월 검색수(전체)</th><th>전월 대비</th><th class="l" title="공정위 정보공개서 기준 점포 수(가맹점+직영점)와 전 기준년도 대비 증감. 연 1회 갱신이라 최신 상황과 차이가 있을 수 있음">점포 수<br><span style="font-weight:400">공정위·상가정보·내부</span></th><th class="l" title="우리는 내부 매출 시스템 기준(최근 12개월). 경쟁사는 공개된 값이 없어 비워 둠">점포당 연매출<br><span style="font-weight:400">최근 12개월</span></th><th>가격</th></tr></thead><tbody>` +
    rows.map(b => {
      const kw = KW.find(k => k.brand_id === b.id && k.grp !== 'need');
      const la = kw ? latestActual(kw.id, 'total') : null;
      const chg = la && la.prev > 0 ? (la.v / la.prev - 1) * 100 : null;
      return `<tr><td class="l"><b>${esc(b.name)}</b></td><td>${b.kind === 'own' ? '<span class="chip ok">우리</span>' : '경쟁사'}</td><td class="l">${esc(b.segment || '')}</td><td>${b.status === 'candidate' ? '<span class="chip new">후보</span>' : '사용'}</td>` +
        `<td>${la ? num(la.v) : '—'}</td><td>${chg == null ? '—' : `<span class="${chg >= 0 ? 'up' : 'dn'}">${sgn(chg)}%</span>`}</td><td class="l" style="vertical-align:top">${storeCell(b)}</td><td class="l" style="vertical-align:top">${salesCell(b)}</td><td style="color:var(--muted)">2단계</td></tr>`;
    }).join('') + '</tbody></table>';
}

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
