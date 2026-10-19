// 로운 홈 — 브랜드 점수판 (v1). 지금 데이터가 있는 섹션(공급·고객)만 숫자를 채우고, 나머지는 바로가기로 둔다.
// 원가 신호등·수요 신호는 다음 단계에서 같은 카드 자리에 연결한다.

const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

const sig = (r, y, g) => `<div class="sg"><span class="r"><i></i>${r}</span><span class="y"><i></i>${y}</span><span class="g"><i></i>${g}</span></div>`;
const card = (href, title, sub, body, foot, cls) => `<a class="hcard ${cls || ''}" href="${href}"><div class="t">${title}<span>${sub}</span></div>${body}<div class="f">${foot}</div></a>`;

function renderCards() {
  const grid = $('homeCards');
  const cards = {};
  cards.cost = card('../cost/', '원가', '샐러드바 메뉴·자재', '<div class="big" style="color:var(--muted2)">신호등 준비 중</div>', '메뉴·자재별 원가 신호등을 다음 단계에서 연결합니다.', 'soon');
  cards.supply = isPlanner ? card('../supply/?v=hq', '공급 · 재고', '본부 재고 로트', '<div class="big">…</div>', '불러오는 중') : '';
  cards.labor = card('../labor/', '생산성', '매장 인시생산성', '<div class="big" style="color:var(--muted2)">바로가기</div>', '전사 대시보드에서 매장별 생산성·인건비율을 봅니다.');
  cards.voc = card('../voc/', '고객', '최근 7일 리뷰', '<div class="big">…</div>', '불러오는 중');
  cards.demand = card('#', '수요 신호', '경쟁사·고객 검색어', '<div class="big" style="color:var(--muted2)">준비 중</div>', '3단계에서 추가합니다.', 'soon');
  cards.sales = card('../sales/', '매출', '예상 대비 실적', '<div class="big" style="color:var(--muted2)">바로가기</div>', '브랜드 대시보드에서 예측 대비 실적을 봅니다.');
  const order = ['cost', 'supply', 'labor', 'voc', 'demand', 'sales'];
  grid.innerHTML = order.map(k => `<div id="hc-${k}" style="display:contents">${cards[k]}</div>`).join('');
  if (isPlanner) fillSupply();
  fillVoc();
}

function setCard(k, html) { const e = $('hc-' + k); if (e) e.innerHTML = html; }

async function fillSupply() {
  try {
    const { data: snaps, error } = await sb.rpc('hq_inventory_snapshots');
    if (error) throw error;
    if (!snaps || !snaps.length) { setCard('supply', card('../supply/?v=upload', '공급 · 재고', '본부 재고 로트', '<div class="big" style="color:var(--muted2)">자료 없음</div>', '업로드 탭에서 본부 재고를 올려주세요.')); return; }
    const date = snaps[0].snapshot_date;
    const lots = [];
    for (let i = 0; ; i++) {
      const { data, error: e2 } = await sb.from('hq_inventory').select('category,expiry_date,shelf_days_left,gap_days,stock_qty,daily_out,unused_fee').eq('snapshot_date', date).order('id').range(i * 1000, i * 1000 + 999);
      if (e2) throw e2;
      lots.push(...data);
      if (data.length < 1000) break;
    }
    const c = { r: 0, y: 0, g: 0 };
    for (const l of lots) {
      for (const k of ['shelf_days_left', 'gap_days', 'stock_qty', 'daily_out', 'unused_fee']) if (l[k] != null) l[k] = Number(l[k]);
      c[lotSignal(l).lv]++;
    }
    setCard('supply', card('../supply/?v=hq', '공급 · 재고', `본부 ${lots.length}로트`, sig(c.r, c.y, c.g), `${date} 기준 · 🔴 유통기한 내 소진불가·평가감·불용 청구 / 🟠 출고부진·유통기한 30일 이내·무출고`));
  } catch (e) {
    setCard('supply', card('../supply/', '공급 · 재고', '본부 재고 로트', '<div class="big" style="color:var(--crit)">불러오기 실패</div>', esc(e.message)));
  }
}

async function fillVoc() {
  try {
    const { data: last, error } = await sb.from('cx_reviews').select('sale_date').order('sale_date', { ascending: false }).limit(1);
    if (error) throw error;
    if (!last || !last.length) { setCard('voc', card('../voc/', '고객', '최근 7일 리뷰', '<div class="big" style="color:var(--muted2)">자료 없음</div>', '리뷰 데이터가 없습니다.')); return; }
    const end = last[0].sale_date;
    const d = new Date(end + 'T00:00:00'); d.setDate(d.getDate() - 6);
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const rows = [];
    for (let i = 0; ; i++) {
      const { data, error: e2 } = await sb.from('cx_reviews').select('id,rating,red_flag,categories').gte('sale_date', start).lte('sale_date', end).order('id').range(i * 1000, i * 1000 + 999);
      if (e2) throw e2;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const red = rows.filter(r => r.red_flag);
    const neg = rows.filter(r => !r.red_flag && (r.rating <= 3 || (r.categories && r.categories.length)));
    const ok = rows.length - red.length - neg.length;
    let open = red.length;
    if (red.length) {
      const { data: acts } = await sb.from('cx_actions').select('review_id,status').in('review_id', red.map(r => r.id));
      const done = new Set((acts || []).filter(a => a.status === '완료').map(a => a.review_id));
      open = red.filter(r => !done.has(r.id)).length;
    }
    setCard('voc', card('../voc/?v=' + (open ? 'red' : 'brand'), '고객', `${start.slice(5)} ~ ${end.slice(5)} 리뷰 ${rows.length}건`, sig(red.length, neg.length, ok), `🔴 레드플래그(미조치 ${open}건) / 🟠 그 외 불만 리뷰(평점 3 이하·부정 요인) / 🟢 정상`));
  } catch (e) {
    setCard('voc', card('../voc/', '고객', '최근 7일 리뷰', '<div class="big" style="color:var(--crit)">불러오기 실패</div>', esc(e.message)));
  }
}

init();
