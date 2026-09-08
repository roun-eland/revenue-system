// 로운 고객(VOC) — L2 리뷰 원문 기반 (고객 PRD v1.0)
// 목적: 불만 요인 비중으로 우선순위를 정하고, 레드플래그를 즉시 잡고, 부정 리뷰에 조치를 남긴다.
// 개인정보 원칙: WEBID 등 개인 식별 정보는 파일에서 읽는 즉시 폐기 — DB에 절대 저장하지 않음.

// ---------- Supabase (통합 프로젝트) ----------
const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (n, d) => d ? Math.round(n / d * 100) + '%' : '—';

// [CX-CLASSIFY-BEGIN] 분류 사전 — 과거분 적재 스크립트(node)가 이 구간을 그대로 재사용하므로 마커를 지우지 말 것
const CX_CATS = ['위생·이물질', '고객응대', '음식품질', '샐러드바 구성', '운영·대기', '가격', '시설·환경', '기타'];
const CX_CAT_KW = {
  '위생·이물질': ['머리카락', '벌레', '바퀴', '이물', '곰팡이', '상한', '상했', '쉰', '비린', '위생', '지저분', '더럽', '더러워', '식중독', '배탈', '설사', '유통기한', '안 씻', '얼룩'],
  '고객응대': ['불친절', '태도', '무시', '반말', '퉁명', '불쾌', '응대', '째려', '싸가지', '건성', '눈치 보', '직원분이 화'],
  '음식품질': ['맛없', '맛이 없', '싱겁', '너무 짜', '짜요', '짰', '식었', '차갑', '퍽퍽', '질기', '질겨', '눅눅', '딱딱', '신선하지', '맛이 별로', '맛이 예전', '육수가', '고기가 얇', '고기 질'],
  '샐러드바 구성': ['샐러드바', '리필', '채워', '보충', '소진', '품절', '떨어져', '안 나오', '안나오', '종류가 적', '메뉴가 적', '다양하지', '구성이 아쉬', '가짓수'],
  '운영·대기': ['웨이팅', '대기', '기다', '줄 서', '일찍 닫', '일찍 마감', '문을 안', '문이 잠', '영업시간', '예약', '늦게 열', '오래 걸'],
  '가격': ['비싸', '비쌈', '가격이', '가격 대비', '가성비가 떨어', '인상', '가격은 좀'],
  '시설·환경': ['좁', '시끄', '더워', '덥고', '추워', '춥고', '에어컨', '주차', '화장실', '의자', '테이블이', '자리가 불편', '냄새가 배', '환기']
};
const CX_FACTOR_CAT = { taste: '음식품질', service: '고객응대', clean: '위생·이물질', price: '가격' };
const CX_NEG = { taste: '아쉬워요', service: '불친절해요', clean: '지저분해요', price: '비싸요' };
const CX_POS = { taste: '맛있어요', service: '친절해요', clean: '깨끗해요', price: '가성비 좋아요' };
const CX_FKEYS = ['taste', 'service', 'clean', 'price'];
const CX_FLABEL = { taste: '맛', service: '서비스', clean: '청결', price: '가격' };

// 리뷰 1건 분류: 본문 키워드 + 부정 요인 응답 → 카테고리, 레드플래그 사전 매칭
function cxClassify(body, rec, redFlags) {
  const b = String(body || '');
  let red = null;
  for (const rf of redFlags) {
    if (rf.active === false || !rf.keyword) continue;
    if (b.includes(rf.keyword)) { red = rf.keyword; break; }
  }
  const cats = new Set();
  for (const cat of Object.keys(CX_CAT_KW)) {
    for (const kw of CX_CAT_KW[cat]) if (b.includes(kw)) { cats.add(cat); break; }
  }
  for (const k of CX_FKEYS) if (rec[k] === CX_NEG[k]) cats.add(CX_FACTOR_CAT[k]);
  const isNeg = (rec.rating != null && rec.rating <= 3) || !!red || CX_FKEYS.some(k => rec[k] === CX_NEG[k]);
  if (isNeg && !cats.size) cats.add('기타');
  return { categories: CX_CATS.filter(c => cats.has(c)), red_flag: !!red, red_keyword: red };
}
// [CX-CLASSIFY-END]

// 불만 리뷰 판정 (저장된 행 기준)
const isNegRow = r => r.rating <= 3 || r.red_flag || (r.categories && r.categories.length > 0);

// ---------- 긍정 카테고리 (본문 자발 언급만 — 요인 만족도 응답과 별개, 저장 안 하고 렌더 시 계산) ----------
const CX_PCATS = ['맛·음식', '친절·응대', '청결', '가성비', '구성·다양성', '분위기·시설', '재방문 의사'];
const CX_PCAT_KW = {
  '맛·음식': ['맛있', '맛나', '신선', '고기가 좋', '고기 질', '퀄리티', '맛집', '고소', '부드럽'],
  '친절·응대': ['친절', '상냥', '배려', '감동', '세심', '잘 웃', '미소', '챙겨주', '챙겨 주', '응대가 좋', '서비스가 좋', '서비스 좋', '덕분에'],
  '청결': ['깨끗', '청결', '깔끔', '위생적'],
  '가성비': ['가성비', '저렴', '합리적', '가격이 착'],
  '구성·다양성': ['다양', '종류가 많', '구성이 좋', '푸짐', '먹을 게 많', '먹을게 많', '골라 먹', '무한'],
  '분위기·시설': ['넓어', '넓고', '쾌적', '분위기 좋', '분위기가 좋', '자리가 좋', '좌석이 넓', '좌석 간격'],
  '재방문 의사': ['또 오', '또 가', '재방문', '자주 오', '자주 가', '단골', '추천', '다음에 또', '또 올']
};
function cxPosCats(body) {
  const b = String(body || ''), cats = [];
  for (const c of CX_PCATS) {
    for (const kw of CX_PCAT_KW[c]) if (b.includes(kw)) { cats.push(c); break; }
  }
  return cats;
}

// ---------- 날짜 헬퍼 (주차별 리뷰 — 주 = 월~일, 주차별 매출과 동일 기준) ----------
const dObj = s => new Date(s + 'T00:00:00');
const dStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addD = (s, n) => { const d = dObj(s); d.setDate(d.getDate() + n); return dStr(d); };
const dowIdx = s => (dObj(s).getDay() + 6) % 7; // 0=월 … 6=일
const daysInYm = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const mdLabel = s => `${+s.slice(5, 7)}/${+s.slice(8)}`;
// 해당 월에 걸치는 월~일 주 목록 (월 범위로 클립)
function monthWeeksMs(ym) {
  const first = ym + '-01', last = `${ym}-${String(daysInYm(ym)).padStart(2, '0')}`;
  let s = addD(first, -dowIdx(first));
  const weeks = [];
  for (let n = 1; s <= last; n++, s = addD(s, 7)) {
    const e = addD(s, 6);
    weeks.push({ n, cs: s < first ? first : s, ce: e > last ? last : e });
  }
  return weeks;
}

// ---------- 데이터 ----------
let REVIEWS = [];            // cx_reviews 전체
let ACTIONS = new Map();     // review_id -> {action_text, status}
let REDFLAGS = [];           // cx_red_flags

async function loadReviews() {
  const acc = [];
  for (let i = 0; ; i++) {
    const { data, error } = await sb.from('cx_reviews')
      .select('id,store_code,sale_date,sale_time,age_group,rating,taste,service,clean,price,best_menus,worst_menus,body,categories,red_flag,red_keyword')
      .order('id')
      .range(i * 1000, i * 1000 + 999);
    if (error) throw error;
    acc.push(...data);
    if (data.length < 1000) break;
  }
  REVIEWS = acc;
}
async function loadActions() {
  const { data, error } = await sb.from('cx_actions').select('review_id,action_text,status');
  if (error) throw error;
  ACTIONS = new Map((data || []).map(a => [a.review_id, a]));
}
async function loadRedFlags() {
  const { data, error } = await sb.from('cx_red_flags').select('keyword,grade,active').order('grade').order('keyword');
  if (error) throw error;
  REDFLAGS = data || [];
}

const storeName = code => (OT_DATA[code] && OT_DATA[code].name) || code;
const actionOf = id => ACTIONS.get(id) || null;
const actionStatus = id => { const a = actionOf(id); return a ? a.status : null; };

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
  document.querySelector('#cxNav button[data-view="upload"]').hidden = !isPlanner;

  try {
    await Promise.all([loadReviews(), loadActions(), loadRedFlags()]);
  } catch (e) {
    $('brandKpis').innerHTML = `<div style="grid-column:1/-1;color:var(--crit)">데이터 로드 실패: ${esc(e.message)}</div>`;
    return;
  }
  buildSelectors();
  renderBrand();
  showView('brand');
}
$('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.replace('../'); };

function showView(v) {
  document.querySelectorAll('#cxNav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  for (const k of ['brand', 'wreview', 'store', 'praise', 'red', 'reviews', 'upload']) $('view-' + k).hidden = (k !== v);
  if (v === 'wreview') renderWReview();
  if (v === 'store') renderStore();
  if (v === 'praise') renderPraise();
  if (v === 'red') renderRed();
  if (v === 'reviews') renderReviews(true);
  if (v === 'upload') renderUpload();
}
document.querySelectorAll('#cxNav button').forEach(b => { b.onclick = () => showView(b.dataset.view); });

// ---------- 셀렉터 ----------
function buildSelectors() {
  const yms = [...new Set(REVIEWS.map(r => r.sale_date.slice(0, 7)))].sort().reverse();
  for (const id of ['wrMonth', 'prMonth']) { // 월 필수 탭 (전체 기간 없음, 기본 = 최신 월)
    const sel = $(id), keep = sel.value;
    sel.innerHTML = '';
    for (const ym of yms) {
      const o = document.createElement('option');
      o.value = ym; o.textContent = `${ym.slice(0, 4)}년 ${+ym.slice(5)}월`;
      sel.appendChild(o);
    }
    if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  }
  for (const id of ['brandMonth', 'stMonth']) {
    const sel = $(id), keep = sel.value;
    sel.innerHTML = '<option value="">전체 기간</option>';
    for (const ym of yms) {
      const o = document.createElement('option');
      o.value = ym; o.textContent = `${ym.slice(0, 4)}년 ${+ym.slice(5)}월`;
      sel.appendChild(o);
    }
    if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  }
  const codes = [...new Set(REVIEWS.map(r => r.store_code))].sort();
  for (const id of ['stStore', 'rvStore', 'redStore', 'prStore']) {
    const sel = $(id), keep = sel.value;
    sel.innerHTML = id === 'stStore' ? '' : '<option value="">전체 매장</option>';
    if (id === 'stStore') { const o = document.createElement('option'); o.value = ''; o.textContent = '전체 매장'; sel.appendChild(o); }
    for (const c of codes) {
      const o = document.createElement('option');
      o.value = c; o.textContent = `${c} ${storeName(c)}`;
      sel.appendChild(o);
    }
    if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  }
  const cat = $('rvCat');
  cat.innerHTML = '<option value="">전체 카테고리</option>' + CX_CATS.map(c => `<option>${c}</option>`).join('');
}
$('brandMonth').onchange = renderBrand;
$('stStore').onchange = renderStore;
$('stMonth').onchange = renderStore;
$('wrMonth').onchange = () => { wrSel = null; renderWReview(); };
$('prMonth').onchange = renderPraise;
$('prStore').onchange = renderPraise;
$('redStore').onchange = renderRed;
$('redStatus').onchange = renderRed;
for (const id of ['rvStore', 'rvCat', 'rvStatus', 'rvScope']) $(id).onchange = () => renderReviews(true);

const filterYm = (rows, ym) => ym ? rows.filter(r => r.sale_date.slice(0, 7) === ym) : rows;
const avgRating = rows => rows.length ? (rows.reduce((t, r) => t + r.rating, 0) / rows.length) : 0;
const posRate = (rows, k) => {
  const ans = rows.filter(r => r[k]);
  if (!ans.length) return null;
  return ans.filter(r => r[k] === CX_POS[k]).length / ans.length;
};

// ---------- V1 브랜드 대시보드 ----------
function renderBrand() {
  const rows = filterYm(REVIEWS, $('brandMonth').value);
  const neg = rows.filter(isNegRow);
  const red = rows.filter(r => r.red_flag);
  const redOpen = red.filter(r => actionStatus(r.id) !== '완료');
  $('brandKpis').innerHTML = `
    <div><div class="k">리뷰 수</div><div class="v">${rows.length.toLocaleString()}건</div><div class="s">매장 ${new Set(rows.map(r => r.store_code)).size}곳</div></div>
    <div><div class="k">평균 평점</div><div class="v">${rows.length ? avgRating(rows).toFixed(2) : '—'}</div><div class="s">5점 만점</div></div>
    <div><div class="k">불만 리뷰 비중</div><div class="v">${pct(neg.length, rows.length)}</div><div class="s">${neg.length.toLocaleString()}건 (평점≤3·부정요인·레드플래그)</div></div>
    <div><div class="k">🚨 레드플래그</div><div class="v" style="${red.length ? 'color:var(--crit)' : ''}">${red.length}건</div><div class="s">${redOpen.length ? `<b style="color:var(--crit)">미조치 ${redOpen.length}건</b>` : red.length ? '전건 조치 완료' : '감지 없음'}</div></div>`;

  const brand = {};
  for (const k of CX_FKEYS) brand[k] = posRate(rows, k);
  const codes = [...new Set(rows.map(r => r.store_code))].sort();
  const sig = (v, b) => v === null ? '' : v >= b ? ' class="sig-good"' : v < b - 0.10 ? ' class="sig-crit"' : '';
  let h = `<table><colgroup><col style="width:150px"><col style="width:70px"><col style="width:80px"><col style="width:80px">${'<col style="width:88px">'.repeat(4)}<col style="width:90px"></colgroup>
    <thead><tr><th>매장</th><th>리뷰</th><th>평균 평점</th><th>불만 비중</th><th>맛 긍정</th><th>서비스 긍정</th><th>청결 긍정</th><th>가격 긍정</th><th>🚨 레드플래그</th></tr></thead><tbody>`;
  for (const c of codes) {
    const sr = rows.filter(r => r.store_code === c);
    const sneg = sr.filter(isNegRow);
    const sred = sr.filter(r => r.red_flag);
    const sredOpen = sred.filter(r => actionStatus(r.id) !== '완료');
    h += `<tr style="cursor:pointer" onclick="gotoStore('${c}')"><td style="text-align:left"><b>${c}</b> ${esc(storeName(c))}</td><td>${sr.length}</td><td><b>${avgRating(sr).toFixed(2)}</b></td><td${sneg.length / sr.length >= 0.3 ? ' class="sig-crit"' : ''}>${pct(sneg.length, sr.length)}</td>`;
    for (const k of CX_FKEYS) {
      const v = posRate(sr, k);
      h += `<td${sig(v, brand[k])}>${v === null ? '—' : Math.round(v * 100) + '%'}</td>`;
    }
    h += `<td>${sred.length ? `<b style="color:var(--crit)">${sred.length}건${sredOpen.length ? ` (미조치 ${sredOpen.length})` : ''}</b>` : '—'}</td></tr>`;
  }
  const bAvg = CX_FKEYS.map(k => brand[k] === null ? '—' : Math.round(brand[k] * 100) + '%');
  h += `<tr style="background:var(--fill);font-weight:700"><td style="text-align:left">브랜드 전체</td><td>${rows.length}</td><td>${rows.length ? avgRating(rows).toFixed(2) : '—'}</td><td>${pct(neg.length, rows.length)}</td><td>${bAvg[0]}</td><td>${bAvg[1]}</td><td>${bAvg[2]}</td><td>${bAvg[3]}</td><td>${red.length ? red.length + '건' : '—'}</td></tr>`;
  h += '</tbody></table>';
  $('brandTable').innerHTML = h;
}
function gotoStore(code) {
  $('stStore').value = code;
  showView('store');
}

// ---------- V2 매장 요인 분석 ----------
let paretoChart = null, posParetoChart = null;

// 파레토 표 공용 (카테고리·건수·비중·누적·미니바)
function paretoTableHtml(cnt, ordered) {
  if (!ordered.length) return '';
  const total = ordered.reduce((t, c) => t + cnt[c], 0);
  let cum = 0;
  let h = '<table><colgroup><col style="width:120px"><col style="width:60px"><col style="width:60px"><col style="width:60px"><col></colgroup><thead><tr><th>카테고리</th><th>건수</th><th>비중</th><th>누적</th><th></th></tr></thead><tbody>';
  for (const c of ordered) {
    cum += cnt[c];
    h += `<tr><td style="text-align:left">${c}</td><td>${cnt[c]}</td><td>${pct(cnt[c], total)}</td><td>${pct(cum, total)}</td><td style="text-align:left"><span class="pbar" style="width:${Math.round(cnt[c] / cnt[ordered[0]] * 100)}px"></span></td></tr>`;
  }
  return h + '</tbody></table>';
}
function renderStore() {
  const code = $('stStore').value;
  let rows = filterYm(REVIEWS, $('stMonth').value);
  if (code) rows = rows.filter(r => r.store_code === code);
  const neg = rows.filter(isNegRow);
  const red = rows.filter(r => r.red_flag);
  $('stKpis').innerHTML = `
    <div><div class="k">리뷰 수</div><div class="v">${rows.length.toLocaleString()}건</div><div class="s">${code ? esc(storeName(code)) : '전체 매장'}</div></div>
    <div><div class="k">평균 평점</div><div class="v">${rows.length ? avgRating(rows).toFixed(2) : '—'}</div><div class="s">5점 만점</div></div>
    <div><div class="k">불만 리뷰</div><div class="v">${neg.length}건</div><div class="s">비중 ${pct(neg.length, rows.length)}</div></div>
    <div><div class="k">🚨 레드플래그</div><div class="v" style="${red.length ? 'color:var(--crit)' : ''}">${red.length}건</div><div class="s">${red.length ? '레드플래그 탭에서 확인' : '감지 없음'}</div></div>`;

  // 불만 파레토: 불만 리뷰의 카테고리 건수 (한 리뷰가 여러 카테고리 가능)
  const cnt = {};
  for (const r of neg) for (const c of (r.categories || [])) cnt[c] = (cnt[c] || 0) + 1;
  const ordered = CX_CATS.filter(c => cnt[c]).sort((a, b) => cnt[b] - cnt[a]);
  if (paretoChart) { paretoChart.destroy(); paretoChart = null; }
  if (typeof Chart !== 'undefined' && ordered.length) {
    paretoChart = new Chart($('stPareto'), {
      type: 'bar',
      data: { labels: ordered, datasets: [{ data: ordered.map(c => cnt[c]), backgroundColor: '#2f3030', borderRadius: 3 }] },
      options: {
        indexAxis: 'y', maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { precision: 0 } } }
      }
    });
  }
  $('stParetoTbl').innerHTML = ordered.length ? paretoTableHtml(cnt, ordered) : '<p class="dnote">불만 리뷰가 없습니다.</p>';

  // 긍정 파레토: 본문 자발 언급 기반 (렌더 시 계산, 저장 안 함)
  const pcnt = {};
  for (const r of rows) for (const c of cxPosCats(r.body)) pcnt[c] = (pcnt[c] || 0) + 1;
  const pordered = CX_PCATS.filter(c => pcnt[c]).sort((a, b) => pcnt[b] - pcnt[a]);
  if (posParetoChart) { posParetoChart.destroy(); posParetoChart = null; }
  if (typeof Chart !== 'undefined' && pordered.length) {
    posParetoChart = new Chart($('stPosPareto'), {
      type: 'bar',
      data: { labels: pordered, datasets: [{ data: pordered.map(c => pcnt[c]), backgroundColor: '#2ea043', borderRadius: 3 }] },
      options: {
        indexAxis: 'y', maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { precision: 0 } } }
      }
    });
  }
  $('stPosParetoTbl').innerHTML = pordered.length ? paretoTableHtml(pcnt, pordered) : '<p class="dnote">긍정 언급이 없습니다.</p>';

  // 연령대 (가로 풀폭 — 비율 폭)
  const ages = [...new Set(rows.map(r => r.age_group || '미상'))].sort();
  let ah = '<table style="width:100%"><colgroup><col style="width:16%"><col style="width:16%"><col style="width:16%"><col style="width:26%"><col style="width:26%"></colgroup><thead><tr><th>연령대</th><th>리뷰</th><th>비중</th><th>평균 평점</th><th>불만 비중</th></tr></thead><tbody>';
  for (const a of ages) {
    const ar = rows.filter(r => (r.age_group || '미상') === a);
    const an = ar.filter(isNegRow);
    ah += `<tr><td>${esc(a)}</td><td>${ar.length}</td><td>${pct(ar.length, rows.length)}</td><td>${avgRating(ar).toFixed(2)}</td><td${an.length / ar.length >= 0.3 ? ' class="sig-crit"' : ''}>${pct(an.length, ar.length)}</td></tr>`;
  }
  ah += '</tbody></table>';
  $('stAge').innerHTML = rows.length ? ah : '<p class="dnote">데이터 없음</p>';

  // 메뉴 TOP — 콤마 구분 다중 응답을 개별 집계
  const menuTop = (field) => {
    const m = {};
    for (const r of rows) for (const name of String(r[field] || '').split(',')) {
      const t = name.trim();
      if (t) m[t] = (m[t] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10);
  };
  const menuTbl = list => {
    if (!list.length) return '<p class="dnote">응답 없음</p>';
    const max = list[0][1];
    let mh = '<table><colgroup><col style="width:34px"><col><col style="width:60px"><col style="width:110px"></colgroup><thead><tr><th>#</th><th>메뉴</th><th>응답</th><th></th></tr></thead><tbody>';
    list.forEach(([name, n], i) => {
      mh += `<tr><td>${i + 1}</td><td style="text-align:left">${esc(name)}</td><td>${n}</td><td style="text-align:left"><span class="pbar" style="width:${Math.round(n / max * 100)}px"></span></td></tr>`;
    });
    return mh + '</tbody></table>';
  };
  $('stWorst').innerHTML = menuTbl(menuTop('worst_menus'));
  $('stBest').innerHTML = menuTbl(menuTop('best_menus'));

  // 최근 불만 리뷰 10건
  const recent = [...neg].sort((a, b) => b.sale_date.localeCompare(a.sale_date)).slice(0, 10);
  $('stRecent').innerHTML = recent.length ? recent.map(r => reviewCard(r, false)).join('') : '<p class="dnote">불만 리뷰가 없습니다.</p>';
}

// ---------- 리뷰 카드 ----------
function reviewCard(r, withAction) {
  const a = actionOf(r.id);
  const st = a ? a.status : null;
  const stChip = st === '완료' ? '<span class="chip st-done">완료</span>'
    : st === '처리중' ? '<span class="chip st-ing">처리중</span>'
    : st === '미처리' ? '<span class="chip st-none">미처리</span>'
    : '<span class="chip st-none">미조치</span>';
  const negChips = CX_FKEYS.filter(k => r[k] === CX_NEG[k]).map(k => `<span class="chip neg">${CX_FLABEL[k]} ${r[k]}</span>`).join('');
  const catChips = (r.categories || []).map(c => `<span class="chip cat">${c}</span>`).join('');
  const redChip = r.red_flag ? `<span class="chip redkw">🚨 ${esc(r.red_keyword)}</span>` : '';
  let h = `<div class="rv${r.red_flag ? ' red' : ''}" data-rid="${r.id}">
    <div class="rv-head"><b>${esc(storeName(r.store_code))}</b><span>${r.sale_date}${r.sale_time ? ' ' + r.sale_time : ''}</span><span>${esc(r.age_group || '')}</span><span class="rate-badge${r.rating <= 3 ? ' lo' : ''}">★${r.rating}</span>${redChip}${negChips}${catChips}${isNegRow(r) ? stChip : ''}</div>
    <div class="rv-body">${esc(r.body)}</div>`;
  if (r.worst_menus) h += `<div class="rv-menus">아쉬운 메뉴: ${esc(r.worst_menus)}</div>`;
  if (withAction) {
    h += `<div class="rv-act">
      <textarea id="act-t-${r.id}" placeholder="해결방법 — 무엇을 어떻게 조치했는지">${a ? esc(a.action_text) : ''}</textarea>
      <select id="act-s-${r.id}"><option${st === '미처리' || !st ? ' selected' : ''}>미처리</option><option${st === '처리중' ? ' selected' : ''}>처리중</option><option${st === '완료' ? ' selected' : ''}>완료</option></select>
      <button class="btn btn-sm" type="button" onclick="saveAction(${r.id})">저장</button>
      <span class="plan-msg" id="act-m-${r.id}"></span>
    </div>`;
  }
  return h + '</div>';
}

async function saveAction(id) {
  const text = $('act-t-' + id).value.trim();
  const status = $('act-s-' + id).value;
  const msg = $('act-m-' + id);
  if (!text) { msg.textContent = '해결방법을 입력하세요'; return; }
  msg.textContent = '저장 중…';
  const { error } = await sb.from('cx_actions').upsert(
    { review_id: id, action_text: text, status, created_by: currentUser.id, updated_at: new Date().toISOString() },
    { onConflict: 'review_id' });
  if (error) { msg.textContent = '실패: ' + error.message; return; }
  ACTIONS.set(id, { review_id: id, action_text: text, status });
  msg.textContent = '저장됨 ✓';
}

// ---------- V6 주차별 리뷰 (주 = 월~일) ----------
let wrSel = null; // {code(''=브랜드), n} — 선택된 셀

function renderWReview() {
  const ym = $('wrMonth').value || [...new Set(REVIEWS.map(r => r.sale_date.slice(0, 7)))].sort().reverse()[0];
  if (!ym) { $('wrTable').innerHTML = '<p class="dnote">적재된 리뷰가 없습니다.</p>'; return; }
  const weeks = monthWeeksMs(ym);
  const monthRows = REVIEWS.filter(r => r.sale_date.slice(0, 7) === ym);
  const codes = [...new Set(monthRows.map(r => r.store_code))].sort();

  const cellStat = rows => rows.length ? { n: rows.length, avg: rows.reduce((t, r) => t + r.rating, 0) / rows.length } : null;
  const inWeek = (rows, w) => rows.filter(r => r.sale_date >= w.cs && r.sale_date <= w.ce);
  const cellHtml = (st, code, n, on) => {
    if (!st) return `<td>—</td>`;
    const cls = st.avg >= 4.5 ? 'sig-good' : st.avg < 4.2 ? 'sig-crit' : '';
    return `<td class="wr-cell${on ? ' on' : ''}" onclick="selectWr('${code}',${n})"><span class="${cls}"><b>${st.avg.toFixed(2)}</b></span> <span class="wr-n">(${st.n})</span></td>`;
  };

  let h = `<table style="width:100%"><colgroup><col style="width:160px">${'<col>'.repeat(weeks.length)}<col style="width:110px"></colgroup><thead><tr><th>매장</th>`;
  for (const w of weeks) h += `<th>${w.n}주차<div class="wr-n">${mdLabel(w.cs)}~${mdLabel(w.ce)}</div></th>`;
  h += '<th>월 누적</th></tr></thead><tbody>';

  const rowHtml = (code, label, rows, boldRow) => {
    let tr = `<tr${boldRow ? ' style="background:var(--fill);font-weight:700"' : ''}><td style="text-align:left">${label}</td>`;
    for (const w of weeks) tr += cellHtml(cellStat(inWeek(rows, w)), code, w.n, wrSel && wrSel.code === code && wrSel.n === w.n);
    tr += cellHtml(cellStat(rows), code, 0, wrSel && wrSel.code === code && wrSel.n === 0);
    return tr + '</tr>';
  };
  h += rowHtml('', '브랜드 전체', monthRows, true);
  for (const c of codes) h += rowHtml(c, `<b>${c}</b> ${esc(storeName(c))}`, monthRows.filter(r => r.store_code === c), false);
  h += '</tbody></table>';
  $('wrTable').innerHTML = h;

  // 선택 셀 상세
  const dc = $('wrDetailCard');
  if (!wrSel) { dc.hidden = true; return; }
  dc.hidden = false;
  let rows = wrSel.code ? monthRows.filter(r => r.store_code === wrSel.code) : monthRows;
  const w = weeks.find(x => x.n === wrSel.n);
  if (w) rows = inWeek(rows, w);
  const label = wrSel.code ? storeName(wrSel.code) : '브랜드 전체';
  $('wrDetailTitle').textContent = `${label} — ${+ym.slice(5)}월 ${w ? `${wrSel.n}주차 (${mdLabel(w.cs)}~${mdLabel(w.ce)})` : '누적'} 핵심 불만`;
  const neg = rows.filter(isNegRow);
  const cnt = {};
  for (const r of neg) for (const c of (r.categories || [])) cnt[c] = (cnt[c] || 0) + 1;
  const ordered = CX_CATS.filter(c => cnt[c]).sort((a, b) => cnt[b] - cnt[a]);
  $('wrCats').innerHTML = ordered.length
    ? ordered.map(c => `<span class="chip cat" style="margin-right:4px">${c} ${cnt[c]}</span>`).join('') + ` <span class="chip">불만 ${neg.length}건 / 전체 ${rows.length}건</span>`
    : `<span class="chip medal">불만 리뷰 없음 🎉 (전체 ${rows.length}건)</span>`;
  $('wrList').innerHTML = [...neg].sort((a, b) => b.sale_date.localeCompare(a.sale_date)).map(r => reviewCard(r, true)).join('');
}
function selectWr(code, n) {
  wrSel = { code, n };
  renderWReview();
  $('wrDetailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- V7 칭찬 사원 (본문에서 서비스 칭찬 + 사람 특징 자동 추출 — DB 저장 안 함) ----------
const PRAISE_RE = /친절|친철|상냥|배려|세심|감동|미소|잘 웃|웃으|웃어|챙겨\s?주|서비스가? 좋|응대가? 좋|덕분에|기분 좋게|먼저 다가/;
const PR_ROLES = [
  ['점장', /점장/], ['매니저', /매니저/], ['사장', /사장/], ['이모', /이모/],
  ['주방', /주방/], ['홀', /홀 ?직원|홀에/], ['카운터·입구', /카운터|입구|안내/], ['알바', /알바/], ['직원', /직원|스탭|스텝|서버/]
];
const PR_TRAITS = [
  ['안경', /안경/], ['긴 머리', /긴 ?머리|장발/], ['짧은 머리·단발', /짧은 ?머리|숏컷|단발/], ['포니테일', /포니테일|묶은 ?머리/],
  ['키 큰', /키가? ?크|키 큰/], ['젊은', /젊은|어려 ?보/], ['중년', /중년|나이가 ?있/]
];
const PR_NAME_BLACKLIST = new Set(['사장', '점장', '매니', '직원', '이모', '삼촌', '선생', '여러', '감사', '죄송', '고마', '수고', '어머', '아버', '부모', '손님', '고객', '저희', '우리', '가족', '아이', '엄마', '아빠', '언니', '오빠', '누나', '형님', '아주머', '아저씨']);

function extractPraise(body) {
  const b = String(body || '');
  if (!PRAISE_RE.test(b)) return null;
  const roles = PR_ROLES.filter(([, re]) => re.test(b)).map(([n]) => n);
  const traits = PR_TRAITS.filter(([, re]) => re.test(b)).map(([n]) => n);
  let gender = null;
  if (/여자 ?분|여성 ?분|여직원|여자 ?직원|여자 ?점장|여성 ?매니저|여자 ?매니저/.test(b)) gender = '여성';
  else if (/남자 ?분|남성 ?분|남직원|남자 ?직원|남자 ?점장|남자 ?매니저/.test(b)) gender = '남성';
  const names = [];
  for (const m of b.matchAll(/([가-힣]{2,3})\s?님/g)) {
    if (!PR_NAME_BLACKLIST.has(m[1]) && !PR_NAME_BLACKLIST.has(m[1].slice(0, 2))) names.push(m[1]);
  }
  return { roles, traits, gender, names: [...new Set(names)] };
}

function renderPraise() {
  const ym = $('prMonth').value || [...new Set(REVIEWS.map(r => r.sale_date.slice(0, 7)))].sort().reverse()[0];
  const codeFilter = $('prStore').value;
  let rows = REVIEWS.filter(r => r.sale_date.slice(0, 7) === (ym || ''));
  if (codeFilter) rows = rows.filter(r => r.store_code === codeFilter);

  const praised = [];
  for (const r of rows) {
    const p = extractPraise(r.body);
    if (p) praised.push({ r, p });
  }

  // 후보 클러스터: 매장 × (이름 > 대표 직책) — 한 매장에 점장·매니저는 보통 소수라 반복 언급 = 같은 사람일 확률 높음
  const clusters = new Map();
  for (const { r, p } of praised) {
    const primary = p.names[0] ? '이름:' + p.names[0] : (p.roles.find(x => x !== '직원') || p.roles[0] || null);
    if (!primary) continue; // 사람 단서가 전혀 없는 일반 칭찬은 후보 집계에서 제외 (아래 전체 목록에는 표시)
    const key = r.store_code + '|' + primary;
    const c = clusters.get(key) || { store: r.store_code, primary, count: 0, roles: new Set(), traits: new Set(), genders: new Set(), names: new Set(), reviews: [] };
    c.count++;
    p.roles.forEach(x => c.roles.add(x)); p.traits.forEach(x => c.traits.add(x));
    if (p.gender) c.genders.add(p.gender); p.names.forEach(x => c.names.add(x));
    c.reviews.push(r);
    clusters.set(key, c);
  }
  const list = [...clusters.values()].sort((a, b) => b.count - a.count || a.store.localeCompare(b.store));
  const repeated = list.filter(c => c.count >= 2);

  $('prKpis').innerHTML = `
    <div><div class="k">칭찬 리뷰</div><div class="v">${praised.length}건</div><div class="s">전체 ${rows.length}건 중 (${pct(praised.length, rows.length)})</div></div>
    <div><div class="k">사람 특정 가능</div><div class="v">${list.reduce((t, c) => t + c.count, 0)}건</div><div class="s">직책·이름 등 단서 있는 칭찬</div></div>
    <div><div class="k">🏅 반복 언급 후보</div><div class="v" style="color:var(--good)">${repeated.length}명</div><div class="s">같은 특징 2회 이상 — 우수사원 후보</div></div>
    <div><div class="k">매장 수</div><div class="v">${new Set(praised.map(x => x.r.store_code)).size}곳</div><div class="s">칭찬 리뷰 있는 매장</div></div>`;

  const chipset = c => [
    ...[...c.names].map(n => `<span class="chip pname">${esc(n)}님</span>`),
    ...[...c.roles].map(n => `<span class="chip role">${n}</span>`),
    ...[...c.genders].map(n => `<span class="chip trait">${n}</span>`),
    ...[...c.traits].map(n => `<span class="chip trait">${n}</span>`)
  ].join(' ');
  $('prClusters').innerHTML = list.length ? '<div class="pr-grid">' + list.map(c => `
    <div class="pr-card${c.count >= 2 ? ' top' : ''}">
      <div class="pr-who">${esc(storeName(c.store))} · ${c.primary.startsWith('이름:') ? esc(c.primary.slice(3)) + '님' : c.primary}${c.count >= 2 ? ' <span class="chip medal">🏅 ' + c.count + '회 언급</span>' : ''}</div>
      <div class="pr-cnt">${c.count}건 · ${chipset(c)}</div>
      ${c.reviews.slice(0, 3).map(r => `<div class="pr-quote">${r.sale_date.slice(5)} · ★${r.rating} — ${esc(String(r.body).replace(/\s+/g, ' ').slice(0, 90))}…</div>`).join('')}
    </div>`).join('') + '</div>'
    : '<p class="dnote">이 달에는 사람을 특정할 단서(직책·이름)가 있는 칭찬 리뷰가 없습니다.</p>';

  const prRows = praised.sort((a, b) => b.r.sale_date.localeCompare(a.r.sale_date));
  $('prList').innerHTML = prRows.length ? prRows.map(({ r, p }) => {
    const chips = [...p.names.map(n => `<span class="chip pname">${esc(n)}님</span>`), ...p.roles.map(n => `<span class="chip role">${n}</span>`),
      ...(p.gender ? [`<span class="chip trait">${p.gender}</span>`] : []), ...p.traits.map(n => `<span class="chip trait">${n}</span>`)].join(' ');
    return `<div class="rv"><div class="rv-head"><b>${esc(storeName(r.store_code))}</b><span>${r.sale_date}</span><span class="rate-badge">★${r.rating}</span>${chips}</div><div class="rv-body">${esc(r.body)}</div></div>`;
  }).join('') : '<p class="dnote">칭찬 리뷰가 없습니다.</p>';
}

// ---------- V3 레드플래그 ----------
function renderRed() {
  const code = $('redStore').value;
  const openOnly = $('redStatus').value === 'open';
  let rows = REVIEWS.filter(r => r.red_flag);
  if (code) rows = rows.filter(r => r.store_code === code);
  const open = rows.filter(r => actionStatus(r.id) !== '완료');
  if (openOnly) rows = open;
  rows = [...rows].sort((a, b) => b.sale_date.localeCompare(a.sale_date));

  const byGrade = {};
  for (const r of REVIEWS.filter(x => x.red_flag)) {
    const g = (REDFLAGS.find(f => f.keyword === r.red_keyword) || {}).grade || '기타';
    byGrade[g] = (byGrade[g] || 0) + 1;
  }
  $('redKpis').innerHTML = `
    <div><div class="k">레드플래그 전체</div><div class="v" style="color:var(--crit)">${REVIEWS.filter(r => r.red_flag).length}건</div><div class="s">${Object.entries(byGrade).map(([g, n]) => `${g} ${n}`).join(' · ')}</div></div>
    <div><div class="k">미조치</div><div class="v" style="${open.length ? 'color:var(--crit)' : ''}">${open.length}건</div><div class="s">완료 처리 전</div></div>
    <div><div class="k">조치율</div><div class="v">${pct(rows.length ? REVIEWS.filter(r => r.red_flag && actionStatus(r.id) === '완료').length : 0, REVIEWS.filter(r => r.red_flag).length)}</div><div class="s">완료 ÷ 전체</div></div>`;
  $('redList').innerHTML = rows.length ? rows.map(r => reviewCard(r, true)).join('') : '<p class="dnote">해당 조건의 레드플래그 리뷰가 없습니다. 🎉</p>';
}

// ---------- V4 리뷰·조치 ----------
let rvShown = 0;
const RV_PAGE = 30;
function rvFiltered() {
  let rows = REVIEWS;
  const code = $('rvStore').value, cat = $('rvCat').value, st = $('rvStatus').value, scope = $('rvScope').value;
  if (scope === 'neg') rows = rows.filter(isNegRow);
  if (code) rows = rows.filter(r => r.store_code === code);
  if (cat) rows = rows.filter(r => (r.categories || []).includes(cat));
  if (st === 'none') rows = rows.filter(r => !actionOf(r.id));
  else if (st) rows = rows.filter(r => actionStatus(r.id) === st);
  return [...rows].sort((a, b) => b.sale_date.localeCompare(a.sale_date) || b.id - a.id);
}
function renderReviews(reset) {
  const rows = rvFiltered();
  if (reset) { rvShown = 0; $('rvList').innerHTML = ''; }
  const next = rows.slice(rvShown, rvShown + RV_PAGE);
  $('rvList').insertAdjacentHTML('beforeend', next.map(r => reviewCard(r, true)).join(''));
  rvShown += next.length;
  $('rvMore').hidden = rvShown >= rows.length;
  $('rvCount').textContent = `${rvShown} / ${rows.length}건`;
  if (!rows.length) $('rvList').innerHTML = '<p class="dnote">조건에 맞는 리뷰가 없습니다.</p>';
}
$('rvMore').onclick = () => renderReviews(false);

// ---------- V5 업로드 (planner) ----------
function renderUpload() {
  // 적재 현황
  const yms = {};
  for (const r of REVIEWS) { const ym = r.sale_date.slice(0, 7); (yms[ym] = yms[ym] || []).push(r); }
  let h = '<table><colgroup><col style="width:100px"><col style="width:80px"><col style="width:80px"><col style="width:100px"><col style="width:110px"></colgroup><thead><tr><th>월</th><th>리뷰</th><th>매장 수</th><th>레드플래그</th><th>판매일 범위</th></tr></thead><tbody>';
  for (const ym of Object.keys(yms).sort().reverse()) {
    const rs = yms[ym];
    const ds = rs.map(r => r.sale_date).sort();
    h += `<tr><td>${ym}</td><td>${rs.length.toLocaleString()}</td><td>${new Set(rs.map(r => r.store_code)).size}</td><td>${rs.filter(r => r.red_flag).length || '—'}</td><td>${ds[0].slice(8)}일~${ds[ds.length - 1].slice(8)}일</td></tr>`;
  }
  h += `<tr style="background:var(--fill);font-weight:700"><td>전체</td><td>${REVIEWS.length.toLocaleString()}</td><td>${new Set(REVIEWS.map(r => r.store_code)).size}</td><td>${REVIEWS.filter(r => r.red_flag).length}</td><td></td></tr></tbody></table>`;
  $('loadStat').innerHTML = REVIEWS.length ? h : '<p class="dnote">적재된 리뷰가 없습니다.</p>';

  // 레드플래그 사전
  let fh = '<table><colgroup><col style="width:160px"><col style="width:70px"><col style="width:70px"><col style="width:80px"></colgroup><thead><tr><th>키워드</th><th>등급</th><th>감지</th><th>사용</th></tr></thead><tbody>';
  for (const f of REDFLAGS) {
    const n = REVIEWS.filter(r => r.red_keyword === f.keyword).length;
    fh += `<tr><td style="text-align:left"><b>${esc(f.keyword)}</b></td><td>${f.grade}</td><td>${n || '—'}</td><td><button class="btn btn-sm" type="button" onclick="toggleRf('${esc(f.keyword).replace(/'/g, "\\'")}')">${f.active === false ? '<span style="color:var(--muted2)">중지됨</span>' : '<b style="color:var(--good)">사용중</b>'}</button></td></tr>`;
  }
  fh += '</tbody></table>';
  $('rfTable').innerHTML = fh;
}

async function toggleRf(kw) {
  if (!isPlanner) return;
  const f = REDFLAGS.find(x => x.keyword === kw);
  if (!f) return;
  const { error } = await sb.from('cx_red_flags').update({ active: f.active === false }).eq('keyword', kw);
  if (error) { $('rfMsg').textContent = '실패: ' + error.message; return; }
  f.active = f.active === false;
  renderUpload();
}
$('rfAdd').onclick = async () => {
  const kw = $('rfKw').value.trim(), grade = $('rfGrade').value;
  if (!kw) { $('rfMsg').textContent = '키워드를 입력하세요'; return; }
  const { error } = await sb.from('cx_red_flags').upsert({ keyword: kw, grade, active: true });
  if (error) { $('rfMsg').textContent = '실패: ' + error.message; return; }
  $('rfKw').value = '';
  await loadRedFlags();
  renderUpload();
  $('rfMsg').textContent = `'${kw}' 추가됨 — 기존 리뷰에 소급하려면 재스캔`;
};

// 사전 변경 소급: 저장된 전 리뷰를 현재 사전·키워드로 재분류, 달라진 행만 갱신
$('rfRescan').onclick = async () => {
  if (!isPlanner) return;
  $('rfMsg').textContent = '재스캔 중…';
  const changed = [];
  for (const r of REVIEWS) {
    const c = cxClassify(r.body, r, REDFLAGS.filter(f => f.active !== false));
    const same = c.red_flag === r.red_flag && (c.red_keyword || null) === (r.red_keyword || null)
      && JSON.stringify(c.categories) === JSON.stringify(r.categories || []);
    if (!same) changed.push({ id: r.id, categories: c.categories, red_flag: c.red_flag, red_keyword: c.red_keyword });
  }
  for (const ch of changed) {
    const { error } = await sb.from('cx_reviews').update({ categories: ch.categories, red_flag: ch.red_flag, red_keyword: ch.red_keyword }).eq('id', ch.id);
    if (error) { $('rfMsg').textContent = '실패: ' + error.message; return; }
    const r = REVIEWS.find(x => x.id === ch.id);
    Object.assign(r, ch);
  }
  $('rfMsg').textContent = `재스캔 완료 — ${changed.length}건 갱신`;
  renderUpload();
};

// ---------- 리뷰 파일 파서 ----------
const dt8 = s => { const t = String(s).replace(/\D/g, ''); return t.length === 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null; };
const tm6 = s => { const t = String(s == null ? '' : s).replace(/\D/g, ''); return t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : ''; };

$('rvFile').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = $('rvFileMsg');
  if (!isPlanner) { msg.textContent = '업로드는 기획자 계정만 가능합니다'; return; }
  msg.textContent = '파싱 중…';
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
    const head = rows[0].map(x => String(x).trim());
    const col = name => head.indexOf(name);
    const need = ['작성일', '매장코드', 'POS번호', '영수증번호', '판매일자', '판매시간', '연령대', '평점', '맛만족도', '서비스만족도', '청결만족도', '가격만족도', '다시먹고싶은메뉴', '아쉬운메뉴', '내용'];
    const miss = need.filter(n => col(n) < 0);
    if (miss.length) { msg.textContent = '열 누락: ' + miss.join(', '); return; }
    // ⚠ WEBID 열은 의도적으로 읽지 않음 — 개인 식별 정보는 DB 비저장 원칙
    const flags = REDFLAGS.filter(f => f.active !== false);
    const recs = [];
    let redN = 0;
    for (const row of rows.slice(1)) {
      const store = String(row[col('매장코드')] || '').trim();
      const sd = dt8(row[col('판매일자')]);
      if (!store || !sd) continue;
      const rec = {
        store_code: store,
        sale_date: sd,
        sale_time: tm6(row[col('판매시간')]),
        pos_no: String(row[col('POS번호')] == null ? '' : row[col('POS번호')]),
        receipt_no: String(row[col('영수증번호')] == null ? '' : row[col('영수증번호')]),
        written_date: dt8(row[col('작성일')]),
        age_group: String(row[col('연령대')] || '').trim() || null,
        rating: +row[col('평점')] || null,
        taste: String(row[col('맛만족도')] || '').trim() || null,
        service: String(row[col('서비스만족도')] || '').trim() || null,
        clean: String(row[col('청결만족도')] || '').trim() || null,
        price: String(row[col('가격만족도')] || '').trim() || null,
        best_menus: String(row[col('다시먹고싶은메뉴')] || '').trim() || null,
        worst_menus: String(row[col('아쉬운메뉴')] || '').trim() || null,
        body: String(row[col('내용')] == null ? '' : row[col('내용')])
      };
      const c = cxClassify(rec.body, rec, flags);
      rec.categories = c.categories; rec.red_flag = c.red_flag; rec.red_keyword = c.red_keyword;
      if (c.red_flag) redN++;
      recs.push(rec);
    }
    if (!recs.length) { msg.textContent = '유효한 행이 없습니다'; return; }
    msg.textContent = `저장 중… (0/${recs.length})`;
    for (let i = 0; i < recs.length; i += 400) {
      const { error } = await sb.from('cx_reviews').upsert(recs.slice(i, i + 400),
        { onConflict: 'store_code,sale_date,sale_time,pos_no,receipt_no' });
      if (error) { msg.textContent = '저장 실패: ' + error.message; return; }
      msg.textContent = `저장 중… (${Math.min(i + 400, recs.length)}/${recs.length})`;
    }
    await loadReviews();
    buildSelectors();
    renderUpload();
    msg.textContent = `완료 — ${recs.length.toLocaleString()}건 반영 (레드플래그 ${redN}건 감지) · WEBID는 저장하지 않았습니다`;
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
  } finally {
    e.target.value = '';
  }
};

init();
