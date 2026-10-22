// 로운 공통 좌측 내비게이터 (2026-10-19 v2) — 모든 화면이 이 파일 하나를 불러온다.
// 메뉴는 아래 SECTIONS 한 곳만 고치면 된다. 지금 보고 있는 섹션의 항목은 화면의 실제 탭 버튼을 그대로 따라간다.
// 롤백: ① 주소 뒤에 ?nav=old 를 붙이면 예전 상단 메뉴로 돌아가고(브라우저에 기억됨), 사이드바의 "이전 화면" 링크도 같다.
//       ② 완전히 걷어내려면 각 화면의 nav.css·nav.js 두 줄을 지우면 된다 (git 태그 pre-nav-v2 = 적용 전 상태).

(function () {
  // 메뉴 아이콘 (선 아이콘, 24x24) — 섹션 id별
  const ICONS = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/>',
    sales: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
    labor: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    cost: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 8.5 3.5 4.5 3.5-4.5M8.5 12.5h7M8.5 15.5h7"/>',
    supply: '<path d="m3.5 7.5 8.5-4 8.5 4v9l-8.5 4-8.5-4z"/><path d="m3.5 7.5 8.5 4 8.5-4M12 11.5v9"/>',
    demand: '<circle cx="10.5" cy="10.5" r="6"/><path d="m20 20-5.2-5.2"/>',
    voc: '<path d="M4 5.5h16V16H10l-4.5 3.5V16H4z"/>'
  };
  const ico = id => `<svg class="sb-ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[id] || ''}</svg>`;

  const SECTIONS = [
    { id: 'home', label: '홈', mark: '홈', href: 'home/' },
    { id: 'sales', label: '매출', mark: '매', href: 'sales/', nav: '#sfNav button', attr: 'view',
      items: [['brand', '브랜드 대시보드'], ['daily', '매장 일별'], ['weekly', '주차별 매출'], ['acc', '정확도 피드백'], ['admin', '발행 관리', 1]] },
    { id: 'labor', label: '생산성', mark: '생', href: 'labor/', nav: '#otNav button', attr: 'view',
      items: [['dash', '전사 대시보드'], ['plan', '계획 시뮬레이션'], ['feedback', '매장 피드백'], ['actual', '실적 입력', 1], ['ref', '기준정보', 1]] },
    { id: 'cost', label: '원가', mark: '원', href: 'cost/', nav: '.tab-nav .tab-btn', attr: 'tab',
      items: [['pivot', '대시보드'], ['season-design', '시즌설계'], ['produce', '농산 모니터링'], ['data-group', '데이터']] },
    { id: 'supply', label: '공급', mark: '공', href: 'supply/', nav: '#spNav button', attr: 'view',
      items: [['hq', '본부 재고', 1], ['upload', '데이터 업로드', 1]] },
    { id: 'demand', label: '수요', mark: '수', href: 'demand/', nav: '#dmNav button', attr: 'view',
      items: [['summary', '요약', 1], ['market', '시장', 1], ['search', '검색', 1], ['competitor', '경쟁사', 1], ['voice', '고객 반응', 1], ['source', '출처·한계', 1], ['settings', '설정', 1]] },
    { id: 'voc', label: '고객', mark: '고', href: 'voc/', nav: '#cxNav button', attr: 'view',
      items: [['brand', '브랜드 대시보드'], ['wreview', '주차별 리뷰'], ['store', '매장 요인 분석'], ['praise', '칭찬 사원'], ['red', '레드플래그'], ['reviews', '리뷰·조치'], ['upload', '데이터 업로드', 1]] }
  ];

  const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } }
  };

  // ?nav=old|new 로 모드를 바꾸면 기억해 둔다
  const q = new URLSearchParams(location.search);
  if (q.get('nav') === 'old' || q.get('nav') === 'new') ls.set('roun_nav', q.get('nav'));
  const OLD = q.get('nav') === 'old' || (q.get('nav') !== 'new' && ls.get('roun_nav') === 'old');

  const curId = (location.pathname.match(/\/(home|sales|labor|cost|supply|demand|voc)(\/|$)/) || [])[1] || '';
  const cur = SECTIONS.find(s => s.id === curId);

  // 화면 시작 탭: ?v=키 로 들어오면 그 탭을 먼저 연다 (각 화면의 init 끝에서 navStart('기본탭') 호출)
  window.navStart = function (def) {
    const v = q.get('v');
    if (!v || !cur || !cur.items) return def;
    const btn = document.querySelector(`${cur.nav}[data-${cur.attr}="${v}"]`);
    return btn && !btn.hidden ? v : def;
  };

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ---- 예전 화면: 상단 메뉴 끝에 "새 메뉴" 링크만 붙인다 ----
  function oldMode() {
    const g = document.querySelector('.gnav');
    if (!g) return;
    const a = el('a', 'gnav-item', '새 메뉴로 보기');
    a.href = '?nav=new'; a.style.marginLeft = 'auto'; a.style.fontWeight = '500'; a.style.fontSize = '12px';
    g.appendChild(a);
  }

  // ---- 새 메뉴 ----
  let role = null, email = '';
  const groupOpen = JSON.parse(ls.get('roun_nav_open') || '{}');

  function btnsOf(sec) { return sec.nav ? [...document.querySelectorAll(sec.nav)] : []; }
  function keyOf(btn, sec) { return btn.dataset[sec.attr]; }

  function itemsFor(sec) {
    if (!sec.items) return [];
    if (sec.id === curId) {   // 현재 섹션은 화면의 실제 탭 버튼을 따른다 (권한으로 숨겨진 탭은 자동 제외)
      return btnsOf(sec).filter(b => !b.hidden && !b.disabled).map(b => ({ key: keyOf(b, sec), label: b.textContent.replace(/\s+/g, ' ').trim() }));
    }
    return sec.items.filter(([, , p]) => !p || role === 'planner').map(([key, label]) => ({ key, label }));
  }
  function activeKey(sec) {
    const b = btnsOf(sec).find(x => x.classList.contains('on') || x.classList.contains('is-active'));
    return b ? keyOf(b, sec) : null;
  }

  let sidebar, bar, bcText;

  function build() {
    document.body.classList.add('navv2');
    if (ls.get('roun_nav_mini') === '1') document.body.classList.add('sbmini');

    sidebar = el('aside'); sidebar.id = 'sidebar';
    bar = el('div', 'navbc');
    const ham = el('button', 'navbc-ham', '☰'); ham.type = 'button'; ham.setAttribute('aria-label', '메뉴 열기');
    ham.onclick = () => document.body.classList.toggle('sbopen');
    bcText = el('span', 'navbc-text');
    bar.append(ham, bcText);
    const app = document.getElementById('appView');
    app.insertBefore(bar, app.firstChild);
    document.body.appendChild(sidebar);
    document.body.appendChild(Object.assign(el('div', 'sb-scrim'), { onclick: () => document.body.classList.remove('sbopen') }));
    render();
    if (curId === 'cost' && q.get('v')) { const b = btnsOf(cur).find(x => keyOf(x, cur) === q.get('v')); if (b) setTimeout(() => b.click(), 0); }

    // 탭이 바뀌면 사이드바 강조와 경로를 따라간다
    if (cur && cur.nav) {
      const mo = new MutationObserver(() => paint());
      btnsOf(cur).forEach(b => mo.observe(b, { attributes: true, attributeFilter: ['class', 'hidden'] }));
    }
  }

  function render() {
    let h = `<div class="sb-top"><span class="sb-brand">로운</span><button type="button" class="sb-mini" id="sbMini" title="메뉴 접기·펼치기" aria-label="메뉴 접기·펼치기">«</button></div><nav class="sb-nav">`;
    for (const s of SECTIONS) {
      if (s.soon) { h += `<div class="sb-g soon" title="준비 중">${ico(s.id)}<span class="sb-t">${s.label}</span><span class="sb-tag">준비 중</span></div>`; continue; }
      const items = itemsFor(s);
      if (s.items && !items.length) continue;                       // 권한 때문에 볼 항목이 없는 섹션은 숨김
      const isCur = s.id === curId;
      const open = isCur ? groupOpen[s.id] !== false : !!groupOpen[s.id];
      if (!s.items) {
        h += `<a class="sb-g${isCur ? ' on' : ''}" href="../${s.href}">${ico(s.id)}<span class="sb-t">${s.label}</span></a>`;
        continue;
      }
      h += `<div class="sb-grp${open ? ' open' : ''}${isCur ? ' cur' : ''}" data-sec="${s.id}">
        <button type="button" class="sb-g sb-gh" data-sec="${s.id}">${ico(s.id)}<span class="sb-t">${s.label}</span><span class="sb-car">▸</span></button>
        <div class="sb-items">${items.map(it => `<a class="sb-i" data-key="${esc(it.key)}" href="${isCur ? '#' : `../${s.href}?v=${encodeURIComponent(it.key)}`}">${esc(it.label)}</a>`).join('')}</div></div>`;
    }
    h += `</nav><div class="sb-foot"><div class="sb-who">${esc(email)}${role ? ` <span class="sb-role">${role === 'planner' ? '기획자' : '매장 관리자'}</span>` : ''}</div><a class="sb-old" href="?nav=old">이전 화면으로 보기</a></div>`;
    sidebar.innerHTML = h;

    sidebar.querySelector('#sbMini').onclick = () => {
      const m = document.body.classList.toggle('sbmini'); ls.set('roun_nav_mini', m ? '1' : '0');
    };
    sidebar.querySelectorAll('.sb-gh').forEach(b => {
      b.onclick = () => {
        const id = b.dataset.sec, g = b.parentElement;
        if (document.body.classList.contains('sbmini')) { document.body.classList.remove('sbmini'); ls.set('roun_nav_mini', '0'); g.classList.add('open'); groupOpen[id] = true; }
        else { const o = g.classList.toggle('open'); groupOpen[id] = o; }
        ls.set('roun_nav_open', JSON.stringify(groupOpen));
      };
    });
    // 현재 섹션 항목은 실제 탭 버튼을 눌러준다
    sidebar.querySelectorAll('.sb-grp.cur .sb-i').forEach(a => {
      a.onclick = ev => {
        ev.preventDefault();
        const b = btnsOf(cur).find(x => keyOf(x, cur) === a.dataset.key);
        if (b) b.click();
        document.body.classList.remove('sbopen');
      };
    });
    paint();
  }

  function paint() {
    if (!cur) return;
    const k = cur.nav ? activeKey(cur) : null;
    sidebar.querySelectorAll('.sb-grp.cur .sb-i').forEach(a => a.classList.toggle('on', a.dataset.key === k));
    const it = k ? itemsFor(cur).find(i => i.key === k) : null;
    bcText.innerHTML = `<a href="../home/">홈</a>` + (cur.id === 'home' ? '' : ` › <a href="../${cur.href}">${cur.label}</a>` + (it ? ` › <b>${esc(it.label)}</b>` : ''));
    if (cur.id === 'home') bcText.innerHTML = '<b>홈</b>';
  }

  async function loadWho() {
    try {
      const c = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: false } });
      const { data: { session } } = await c.auth.getSession();
      if (!session) return;
      email = session.user.email || '';
      const { data } = await c.from('ot_profiles').select('role').eq('user_id', session.user.id).maybeSingle();
      role = (data && data.role) || 'planner';
    } catch (e) { /* 권한을 못 읽어도 현재 섹션 메뉴는 동작 */ }
    if (sidebar) render();
  }

  function start() {
    if (OLD) { oldMode(); return; }
    const app = document.getElementById('appView');
    if (!app) return;
    const go = () => { if (!sidebar) { build(); loadWho(); } };
    if (!app.hidden) go();
    else new MutationObserver((_, ob) => { if (!app.hidden) { ob.disconnect(); go(); } }).observe(app, { attributes: true, attributeFilter: ['hidden'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
