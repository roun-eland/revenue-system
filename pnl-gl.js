// 예상실적 — 전표(원가요소 단위) 기반 과거 실적 · 전표 업로드 (2026-11-03)
// pnl.js 보다 먼저 불러온다(최상위에서는 pnl.js 의 값을 쓰지 않고, 함수 안에서만 쓴다).
//  · 실적 추이 탭: 보기 대상(브랜드 실적표 / 브랜드·매장합계·법인안분·브랜드안분·매장별 전표 합계) + 계정 칸을 누르면 전표 내역
//  · 전표 업로드 탭: 엑셀(이름·전표 헤더 텍스트(분류용)·원가 요소·금액·코스트 센터·기능 영역·전표 번호·전기일) → gl_voucher (해당 월 교체)
//  · 분류 규칙: 코스트센터가 store_info.cost_center 와 일치(끝 S 는 판관용 코스트센터) → 매장 / 그 밖의 비매장 중 텍스트에 EP → 법인 안분 / 나머지 → 브랜드 안분
//  · 인건비 계열(급여·퇴직급여·상여, gl_acct_map.hide_detail)은 업로드 때 전표번호·텍스트를 비우고 금액만 저장, 화면에서도 내역을 보여주지 않는다
//  · 식재료원가(전표 기준) = 식품매출원가(42010301) − 제조 비용 합 — 브랜드 실적표와 월 40~260백만원 차이가 나는 파생 값이다 (원가 시스템 값을 그대로 쓰는 예상 쪽과 다름)

const GL_MFG = ['cogs.4.1', 'cogs.4.2', 'cogs.4.3.1', 'cogs.4.3.2', 'cogs.4.4.1', 'cogs.4.4.2', 'cogs.4.5', 'cogs.4.6', 'cogs.4.7.1', 'cogs.4.7.2', 'cogs.4.7.3', 'cogs.4.8', 'cogs.4.9', 'cogs.4.10', 'pay_ft', 'pay_pt', 'retire', 'cogs.3.3', 'cogs.5', 'cogs.7'];
const GL_NO_BELOW_OP = ['other', 'fin', 'pretax', 'tax_val', 'tax', 'net', 'true_net', 'true_ded'];   // 매장 단위에는 영업외·세금 이하를 보여주지 않는다
const GL_NO_TAX = ['tax_val', 'tax', 'net', 'true_net', 'true_ded'];                                      // 법인세는 추정식이라 전표 기준 표에는 넣지 않는다
const GL_PART_LABEL = { store: '매장', corp: '법인 안분', brand: '브랜드 안분' };

// 조회 API 는 한 번에 1000행까지만 준다 — 그보다 큰 집계(매장×월×계정 등)는 range 로 나눠 끝까지 읽는다 (2026-11-04: 이걸 안 해서 매장별 전표 일부가 빠져 수광비·감가상각이 낮게 나왔다)
// make(from, to) → .range(from, to) 가 붙은 조회. 반환 = 전체 행 배열. 순서가 흔들리지 않게 호출쪽에서 order 를 붙인다.
async function pageAll(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await make(from, from + 999);
    if (r.error) throw r.error;
    const rows = r.data || [];
    for (const x of rows) out.push(x);
    if (rows.length < 1000) break;
  }
  return out;
}

// ---------- 메타(매핑·매장정보) ----------
async function loadGlMeta() {
  const [m, si] = await Promise.all([
    sb.from('gl_acct_map').select('leaf_code,hide_detail').limit(3000),
    sb.from('store_info').select('store_code,store_name,cost_center,extra').order('store_code')
  ]);
  if (m.error) throw m.error;
  if (si.error) throw si.error;
  const all = {}, hid = {};
  for (const r of m.data || []) { all[r.leaf_code] = true; if (!r.hide_detail) hid[r.leaf_code] = false; else if (!(r.leaf_code in hid)) hid[r.leaf_code] = true; }
  S.glLeaves = new Set(Object.keys(all).filter(c => PNL_BY[c]));        // 손익 계정에 걸리는 말단 (food_gross·skip72 등 보조 코드는 제외)
  S.glHidden = new Set(Object.keys(hid).filter(c => hid[c]));
  S.storeInfo = si.data || [];
  S.storeByCc = {};
  for (const r of S.storeInfo) if (r.cost_center) S.storeByCc[r.cost_center] = r.store_code;
  fillAcScope();
}
const glStoreName = r => (OT_DATA && OT_DATA[r.store_code] ? sname(r.store_code) : String(r.store_name || r.store_code).replace(/^로운(샤브 프리미엄)?\s*/, '')) + (r.extra && r.extra['상태'] === '폐점' ? ' (폐점)' : '');
function fillAcScope() {
  const sel = $('acScope'); if (!sel) return;
  const keep = S.acScope;
  sel.innerHTML = `<optgroup label="브랜드"><option value="sheet">브랜드 실적표 (받은 실적)</option><option value="all">브랜드 전체 (전표 합계)</option></optgroup>` +
    `<optgroup label="전표 기준"><option value="stores">매장 합계</option><option value="corp">법인 안분 (EP 배부)</option><option value="brand">브랜드 안분</option></optgroup>` +
    `<optgroup label="매장별 (전표)">${S.storeInfo.map(r => `<option value="${esc(r.store_code)}">${esc(r.store_code)} ${esc(glStoreName(r))}</option>`).join('')}</optgroup>`;
  sel.value = keep || 'sheet';
}
const acKind = () => S.acScope === 'sheet' ? 'sheet' : /^RU\d/.test(S.acScope) ? 'store' : S.acScope;

// ---------- 안분(법인·브랜드) 월 합계 + 전체 매장 월 순매출 — 매장·매장합계 보기의 안분비 줄에 쓴다 ----------
// 안분비 = 그 달 안분 전표 합계(손익 계정만) × (매장 순매출 ÷ 전체 매장 순매출) — 예상(매장 탭)과 같은 매출 비례 방식
async function loadGlAlloc() {
  if (S.glAlloc) return S.glAlloc;
  const [co, br, sl] = await Promise.all([
    pageAll((a, b) => sb.rpc('gl_monthly', { p_scope: 'corp', p_store: null }).order('ym').order('leaf').range(a, b)).then(data => ({ data })),
    pageAll((a, b) => sb.rpc('gl_monthly', { p_scope: 'brand', p_store: null }).order('ym').order('leaf').range(a, b)).then(data => ({ data })),
    sb.rpc('store_sales_monthly', { p_store: null })
  ]);
  for (const r of [co, br, sl]) if (r.error) throw r.error;
  const tot = rows => { const o = {}; for (const r of rows || []) if (PNL_BY[r.leaf] && !EST_ALLOC_SKIP.has(r.leaf)) o[r.ym] = (o[r.ym] || 0) + (+r.amount || 0); return o; };
  const net = {}; for (const r of sl.data || []) net[r.ym] = (+r.gross || 0) / 1.1;
  return (S.glAlloc = { corp: tot(co.data), brand: tot(br.data), net });
}

// ---------- 전표 합계 불러오기 ----------
async function loadGlScope(key) {
  if (S.gl[key]) return S.gl[key];
  const kind = /^RU\d/.test(key) ? 'store' : key;
  const needSales = kind === 'all' || kind === 'stores' || kind === 'store';
  const store = kind === 'store' ? key : null;
  const [g, sl] = await Promise.all([
    pageAll((a, b) => sb.rpc('gl_monthly', { p_scope: kind, p_store: store }).order('ym').order('leaf').range(a, b)).then(data => ({ data })),
    needSales ? sb.rpc('store_sales_monthly', { p_store: kind === 'store' ? key : null }) : Promise.resolve({ data: [] }),
    kind === 'store' || kind === 'stores' ? loadGlAlloc() : Promise.resolve(null)
  ]);
  if (g.error) throw g.error;
  if (sl.error) throw sl.error;
  const byYm = {}, unmapped = {};
  for (const r of g.data || []) {
    (byYm[r.ym] = byYm[r.ym] || {})[r.leaf] = +r.amount;
    if (r.leaf === 'UNMAPPED') unmapped[r.ym] = +r.amount;
  }
  const gross = {}; for (const r of sl.data || []) gross[r.ym] = +r.gross;
  const yms = Object.keys(byYm).sort(), M = {};
  for (const ym of yms) {
    const L = { ...byYm[ym] };
    if (kind === 'store' || kind === 'stores' || kind === 'all') L.food = (L.food_gross || 0) - GL_MFG.reduce((t, c) => t + (L[c] || 0), 0) - (L.skip72 || 0);
    else L.food = L.food_gross || 0;
    if (needSales) { const gr = gross[ym] || 0; L.gross_direct = gr; L.vat = gr - gr / 1.1; }
    M[ym] = evalTree(L);
  }
  return (S.gl[key] = { yms, M, unmapped });
}

const glDescend = (code, set) => { set.add(code); PNL_BY[code].children.forEach(c => glDescend(c, set)); return set; };
function glHiddenRows(kind) {
  const list = kind === 'sheet' ? [] : (kind === 'store' || kind === 'stores') ? GL_NO_BELOW_OP : GL_NO_TAX;
  const s = new Set(); list.forEach(c => glDescend(c, s)); return s;
}
const glLeavesOf = a => { const p = PNL_BY[a.code]; return p.children.length ? p.children.flatMap(c => glLeavesOf(PNL_BY[c])) : [p.code]; };
const glDrillable = a => S.glLeaves.size > 0 && glLeavesOf(a).some(c => S.glLeaves.has(c));

// ---------- 실적 추이 표 ----------
function renderActual(C) {
  const kind = acKind();
  const wrap = $('actualTable'), note = $('actualNote');
  if (!wrap) return;
  let cols = [], yms = [];
  if (kind === 'sheet') {
    yms = Object.keys(S.act).sort();
    cols = yms.map(y => ({ head: ymLabel(y), ym: y, M: S.act[y], est: false }));
  } else {
    const d = S.gl[S.acScope];
    if (!d) {
      wrap.innerHTML = '<p class="dnote" style="padding:12px">전표를 불러오는 중…</p>';
      loadGlScope(S.acScope).then(() => renderAll()).catch(e => { wrap.innerHTML = `<p class="dnote" style="padding:12px;color:var(--crit)">불러오지 못했습니다: ${esc(e.message || e)}</p>`; });
      note.innerHTML = ''; return;
    }
    yms = d.yms;
    cols = yms.map(y => ({ head: ymLabel(y), ym: y, M: d.M[y], est: false }));
    if (!yms.length) { wrap.innerHTML = '<p class="dnote" style="padding:12px">저장된 전표가 없습니다. "전표 업로드" 탭에서 올려 주세요.</p>'; note.innerHTML = ''; return; }
  }
  if (!cols.length) { wrap.innerHTML = '<p class="dnote" style="padding:12px">월별 실적이 아직 없습니다.</p>'; note.innerHTML = ''; return; }
  const estM = kind === 'sheet' || kind === 'all' ? C.brand : kind === 'stores' ? C.total : kind === 'store' ? C.store[S.acScope] : null;
  if (estM) cols.push({ head: `${+S.ym.slice(5)}월 예상`, ym: null, M: estM, est: true });
  const AW = 60, PW = 46, W = 250 + cols.length * (AW + PW) + 20;   // 월마다 액(백만원) / 율(매출액 대비 %) 두 칸
  const withAlloc = kind === 'store' || kind === 'stores';
  if (withAlloc) {   // 열마다 안분비(음수) = −(안분 합계 × 매장 순매출 비율)
    const AL = S.glAlloc, ALE = estAllocTotals(), totE = C.total.sales || 0;
    for (const c of cols) {
      let sh = null, B = 0, Cp = 0;
      if (c.est) { if (ALE && totE) { sh = (c.M.sales || 0) / totE; B = ALE.brand; Cp = ALE.corp; } }
      else if (AL) { const tn = AL.net[c.ym] || 0; if (kind === 'stores') sh = 1; else if (tn) sh = (c.M.sales || 0) / tn; B = AL.brand[c.ym] || 0; Cp = AL.corp[c.ym] || 0; }
      c.al = sh == null ? null : { brand: -B * sh, corp: -Cp * sh };
    }
  }
  const hid = glHiddenRows(kind);
  const baseOf = c => (c.M.sales && Math.round(c.M.sales / 1e6)) ? c.M.sales : (S.act[c.ym] && S.act[c.ym].sales) || 0;
  let h = `<table class="pnl act" style="width:100%;min-width:${W}px"><colgroup><col style="width:250px">${cols.map(() => `<col style="width:${AW}px"><col style="width:${PW}px">`).join('')}</colgroup><thead>` +
    `<tr><th rowspan="2">${esc(acLabel())} · 백만원</th>${cols.map(c => `<th colspan="2" class="ctr${c.est ? ' est' : ''}">${c.head}</th>`).join('')}</tr>` +
    `<tr>${cols.map(c => `<th class="num sub2${c.est ? ' est' : ''}">액</th><th class="num sub2${c.est ? ' est' : ''}">율</th>`).join('')}</tr></thead><tbody>`;
  for (const a of visibleRows(S.mode).filter(x => !hid.has(x.code))) {
    const dr = glDrillable(a);
    h += `<tr class="${rowCls(a)}">${labelCell(a, S.mode, withAlloc && a.code === 'op' ? 'op_ex' : null)}` + cols.map(c => {
      const v = c.M[a.code], base = baseOf(c);
      const has = v != null && Math.round(v / 1e6) !== 0;
      const amt = v == null ? '<span class="z">-</span>' : nf(v / 1e6);
      const rt = has && base ? (v / base * 100).toFixed(1) + '%' : '';
      const click = S.planner && dr && !c.est && c.ym && v != null && v !== 0;   // 전표 내역 보기는 기획자만 (인건비 전표 보호 — 조회 전용 계정은 DB도 막음)
      return `<td class="num${c.est ? ' est' : ''}${click ? ' drl' : ''}"${click ? ` data-code="${a.code}" data-ym="${c.ym}" title="눌러서 전표 내역 보기"` : ''}>${amt}</td><td class="num r${c.est ? ' est' : ''}">${rt}</td>`;
    }).join('') + '</tr>';
  }
  if (withAlloc) {
    // 마지막(영업이익) 줄 바로 뒤에 붙인다 — 영업이익이 마지막 보이는 줄이다(영업외 이하는 숨김)
    const cell = (c, v, key) => { const base = baseOf(c), has = v != null && Math.round(v / 1e6) !== 0; return `<td class="num${c.est ? ' est' : ''}">${v == null ? '<span class="z">-</span>' : nf(v / 1e6)}</td><td class="num r${c.est ? ' est' : ''}">${has && base ? (v / base * 100).toFixed(1) + '%' : ''}</td>`; };
    let ex = '';
    if (!S.folded.has('op_ex')) for (const [n, key] of [['브랜드 안분비', 'brand'], ['법인 안분비', 'corp']]) ex += `<tr class="l1 lf ex"><td class="nm" style="padding-left:20px"><span class="car"></span>${n}</td>` + cols.map(c => cell(c, c.al ? c.al[key] : null)).join('') + '</tr>';
    ex += `<tr class="l1 sub key"><td class="nm" style="padding-left:6px"><span class="car"></span>안분 후 영업이익</td>` + cols.map(c => cell(c, c.al ? (c.M.op || 0) + c.al.brand + c.al.corp : null)).join('') + '</tr>';
    h += ex;
  }
  wrap.innerHTML = h + '</tbody></table>';
  wrap.querySelectorAll('td.drl').forEach(td => { td.onclick = () => openDrill(td.dataset.code, td.dataset.ym); });
  const li = [];
  if (kind === 'sheet') li.push('받은 브랜드 실적표(백만원)입니다. 칸을 누르면 같은 월의 전표 합계 내역을 볼 수 있습니다 (실적표와 반올림·분류 차이가 있을 수 있음).');
  else {
    li.push('전표 합계 기준입니다 — 인건비·제조경비·판관비는 브랜드 실적표와 월 ±1~2백만원 안에서 맞습니다. <b>식재료원가</b>는 식품매출원가에서 제조 비용을 뺀 파생 값이라 원가 시스템 값과 다를 수 있습니다.');
    if (kind === 'store' || kind === 'stores') li.push('매출은 매출 앱(store_sales) 기준 순매출(÷1.1)입니다. 매장 단위에는 영업외·법인세를 넣지 않았습니다. <b>브랜드·법인 안분비</b>는 그 달 안분 전표 합계(법인 = 텍스트에 EP, 브랜드 = 그 밖의 비매장)를 매장 순매출 비율로 나눈 값이고, <b>안분 후 영업이익</b> = 영업이익 − 두 안분비입니다 (영업이익 줄을 누르면 안분비 줄이 접힙니다).');
    const un = Object.keys((S.gl[S.acScope] || {}).unmapped || {});
    if (un.length) li.push(`<span style="color:var(--crit)">계정 매핑이 없는 전표가 있습니다 (${un.join(', ')}) — gl_acct_map 에 추가해야 반영됩니다.</span>`);
  }
  li.push('급여·퇴직급여·상여 전표는 내역을 저장·표시하지 않고 금액만 둡니다.');
  note.innerHTML = '<ul>' + li.map(x => `<li>${x}</li>`).join('') + '</ul>';
}
function acLabel() {
  if (S.acScope === 'sheet') return '로운 브랜드 실적표';
  if (S.acScope === 'all') return '로운 전체 (전표)';
  if (S.acScope === 'stores') return '매장 합계 (전표)';
  if (S.acScope === 'corp') return '법인 안분 (전표)';
  if (S.acScope === 'brand') return '브랜드 안분 (전표)';
  const r = S.storeInfo.find(x => x.store_code === S.acScope);
  return r ? glStoreName(r) + ' (전표)' : S.acScope;
}

// ---------- 전표 내역 ----------
async function openDrill(code, ym) {
  const a = PNL_BY[code], kind = acKind();
  const scope = kind === 'sheet' ? 'all' : kind;
  const store = kind === 'store' ? S.acScope : null;
  const vl = glLeavesOf(a).filter(c => S.glLeaves.has(c));
  const shown = vl.filter(c => !S.glHidden.has(c));
  const box = $('glBody');
  $('glTitle').textContent = `${a.label} · ${ymLabel(ym)} · ${acLabel().replace(' (전표)', '')}`;
  $('glModal').hidden = false;
  if (!shown.length) { box.innerHTML = '<p class="dnote" style="margin:0">인건비 계열(급여·퇴직급여·상여)은 전표 내역을 표시하지 않습니다.</p>'; return; }
  box.innerHTML = '<p class="dnote" style="margin:0">불러오는 중…</p>';
  const { data, error } = await sb.rpc('gl_detail', { p_scope: scope, p_store: store, p_ym: ym, p_leaves: shown });
  if (error) { box.innerHTML = `<p class="dnote" style="margin:0;color:var(--crit)">불러오지 못했습니다: ${esc(error.message)}</p>`; return; }
  const rows = (data || []).slice().sort((x, y) => (+y.amount || 0) - (+x.amount || 0)), tot = rows.reduce((t, r) => t + (+r.amount || 0), 0);   // 금액 큰 순(부호 기준) — 가장 큰 금액이 맨 위, 마이너스(취소·대체)는 맨 아래
  const money = v => { const r = Math.round(v); return r < 0 ? '(' + Math.abs(r).toLocaleString('ko-KR') + ')' : r.toLocaleString('ko-KR'); };
  let h = `<p class="dnote" style="margin:0 0 8px">${rows.length.toLocaleString('ko-KR')}건 · 합계 ${money(tot)}원${rows.length >= 1000 ? ' · 금액 큰 순 1,000건까지만 표시' : ''}${vl.length > shown.length ? ' · 인건비 계열은 제외' : ''}</p>` +
    '<div class="glwrap"><table class="pnl small"><thead><tr><th>전기일</th><th>코스트센터</th><th>매장명</th><th>원가요소</th><th class="num">금액(원)</th><th>텍스트</th></tr></thead><tbody>';
  for (const r of rows) h += `<tr><td>${esc(r.posted)}</td><td>${esc(r.cost_center)} ${esc(GL_PART_LABEL[r.part] && r.part !== 'store' ? '· ' + GL_PART_LABEL[r.part] : '')}</td><td>${esc(r.cc_name || '')}</td><td>${esc(r.acct_name || r.acct_code)}</td><td class="num">${money(+r.amount)}</td><td>${esc(r.text || '')}</td></tr>`;
  box.innerHTML = h + '</tbody></table></div>';
}

// ---------- 전표 업로드 ----------
const GL_EP = /(^|[^A-Za-z])EP/i;
const U = { rows: [], file: '', existing: [], busy: false };
function glYmd(v) {
  if (v instanceof Date && !isNaN(v)) { const d = new Date(v.getTime() + 43200000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
  const m = typeof v === 'string' && v.trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}
// 엑셀 → 행 목록 (시트마다 머리글 줄을 찾는다). 반복된 머리글·합계 줄은 날짜·금액이 없어 자동으로 빠진다
async function glParse(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const out = [], skipped = { noHeader: [], bad: 0 };
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    const hi = rows.findIndex(r => r && r.some(c => String(c == null ? '' : c).trim() === '코스트 센터'));
    if (hi < 0) { skipped.noHeader.push(name); continue; }
    const H = rows[hi].map(c => String(c == null ? '' : c).trim());
    const ix = k => H.findIndex(h => h === k);
    const col = { hdr: ix('전표 헤더 텍스트'), text: ix('이름'), acct: ix('원가 요소'), acctName: ix('원가요소이름'), amt: H.findIndex(h => h.startsWith('Var')), cc: ix('코스트 센터'), ccName: ix('CO 오브젝트이름'), func: ix('기능 영역'), doc: ix('전표 번호'), date: ix('전기일') };
    if ([col.acct, col.amt, col.cc, col.func, col.date].some(v => v < 0)) { skipped.noHeader.push(name); continue; }
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i]; if (!r || r[col.cc] == null) continue;
      const posted = glYmd(r[col.date]);
      const amt = typeof r[col.amt] === 'number' ? r[col.amt] : Number(String(r[col.amt]).replace(/,/g, ''));
      if (!posted || !isFinite(amt)) { skipped.bad++; continue; }
      out.push({
        ym: posted.slice(0, 7), posted, doc: r[col.doc] == null ? null : String(r[col.doc]).trim(), cc: String(r[col.cc]).trim(), ccName: col.ccName >= 0 && r[col.ccName] != null ? String(r[col.ccName]).trim() : null,
        acct: String(r[col.acct]).trim(), acctName: col.acctName >= 0 && r[col.acctName] != null ? String(r[col.acctName]).trim() : null, func: String(r[col.func]).trim(),
        amount: amt,
        hdr: col.hdr >= 0 && r[col.hdr] != null ? String(r[col.hdr]).trim() : null,                    // 전표 헤더 텍스트 — 법인 안분(EP) 분류에만 쓰고 저장·표시하지 않는다
        text: col.text >= 0 && r[col.text] != null ? String(r[col.text]).trim() || null : null          // 전표 내역에 보이는 텍스트 = '이름' 열
      });
    }
  }
  return { rows: out, skipped };
}
// 분류: 매장(코스트센터 일치) / 법인 안분(텍스트 EP) / 브랜드 안분
function glClassify(rows, storeByCc, hiddenPairs) {
  for (const r of rows) {
    const base = /^RU01S\d{4}S$/.test(r.cc) ? r.cc.slice(0, -1) : r.cc;
    r.store = storeByCc[base] || null;
    r.part = r.store ? 'store' : GL_EP.test(r.hdr || '') ? 'corp' : 'brand';   // EP 배부 표시는 전표 헤더 텍스트에 있다 (표시용 텍스트는 '이름' 열이라 따로 둔다)
    r.hide = hiddenPairs.has(r.acct + '|' + r.func);
  }
  return rows;
}
async function glLoadPairs() {
  const { data, error } = await sb.from('gl_acct_map').select('acct_code,func,hide_detail').limit(3000);
  if (error) throw error;
  const known = new Set(), hidden = new Set();
  for (const r of data || []) { known.add(r.acct_code + '|' + r.func); if (r.hide_detail) hidden.add(r.acct_code + '|' + r.func); }
  return { known, hidden };
}
async function glChoose(file) {
  const msg = $('upMsg'), box = $('upPreview');
  $('upSave').disabled = true; U.rows = [];
  if (!file) { box.innerHTML = ''; msg.textContent = ''; return; }
  msg.textContent = '엑셀을 읽는 중…'; msg.className = 'plan-msg';
  try {
    const [{ rows, skipped }, pairs, ex] = await Promise.all([glParse(file), glLoadPairs(), sb.rpc('gl_monthly', { p_scope: 'all', p_store: null })]);
    if (!rows.length) { msg.textContent = '읽을 수 있는 전표 행이 없습니다. 머리글(코스트 센터·원가 요소·전기일 등)을 확인해 주세요.'; msg.className = 'plan-msg err'; box.innerHTML = ''; return; }
    glClassify(rows, S.storeByCc, pairs.hidden);
    U.rows = rows; U.file = file.name; U.existing = [...new Set(((ex && ex.data) || []).map(r => r.ym))];
    const yms = [...new Set(rows.map(r => r.ym))].sort();
    const by = {}; for (const y of yms) by[y] = { n: 0, amt: 0, store: 0, corp: 0, brand: 0 };
    for (const r of rows) { const b = by[r.ym]; b.n++; b.amt += r.amount; b[r.part]++; }
    const unmapped = {}; for (const r of rows) if (!pairs.known.has(r.acct + '|' + r.func)) { const k = r.acct + '|' + r.func; (unmapped[k] = unmapped[k] || { n: 0, name: r.acctName }).n++; }
    const nonStoreCc = {}; for (const r of rows) if (!r.store) nonStoreCc[r.cc] = r.ccName;
    const looksStore = Object.keys(nonStoreCc).filter(c => /^RU01S\d{4}S?$/.test(c));
    const hiddenN = rows.filter(r => r.hide).length;
    const money = v => Math.round(v / 1e6).toLocaleString('ko-KR');
    let h = `<p class="dnote" style="margin:0 0 8px"><b>${esc(file.name)}</b> — 전표 ${rows.length.toLocaleString('ko-KR')}행 · ${yms.length}개월 (${yms[0]} ~ ${yms[yms.length - 1]})${skipped.bad ? ` · 날짜·금액이 없어 건너뛴 줄 ${skipped.bad}` : ''}${skipped.noHeader.length ? ` · 머리글을 못 찾은 시트: ${esc(skipped.noHeader.join(', '))}` : ''}</p>` +
      '<div class="tblwrap"><table class="pnl small"><thead><tr><th>월</th><th class="num">행수</th><th class="num">합계(백만원)</th><th class="num">매장</th><th class="num">법인 안분</th><th class="num">브랜드 안분</th><th>저장 시</th></tr></thead><tbody>' +
      yms.map(y => { const b = by[y]; return `<tr><td>${y}</td><td class="num">${b.n.toLocaleString('ko-KR')}</td><td class="num">${money(b.amt)}</td><td class="num">${b.store.toLocaleString('ko-KR')}</td><td class="num">${b.corp.toLocaleString('ko-KR')}</td><td class="num">${b.brand.toLocaleString('ko-KR')}</td><td>${U.existing.includes(y) ? '<span style="color:var(--crit)">기존 전표 교체</span>' : '신규'}</td></tr>`; }).join('') + '</tbody></table></div>';
    const li = [];
    li.push(`매장 매칭 코스트센터 ${new Set(rows.filter(r => r.store).map(r => r.store)).size}개 매장 · 비매장 코스트센터 ${Object.keys(nonStoreCc).length}개는 안분(텍스트에 EP → 법인, 나머지 → 브랜드)`);
    li.push(`인건비 계열 ${hiddenN.toLocaleString('ko-KR')}행은 전표번호·텍스트를 비우고 금액만 저장합니다.`);
    if (looksStore.length) li.push(`<span style="color:var(--crit)">매장 코스트센터처럼 보이지만 매장정보(코스트센터)에 없는 것: ${esc(looksStore.join(', '))} — 매장정보에서 코스트센터를 맞춘 뒤 다시 올리거나, 이대로 저장하면 브랜드 안분으로 들어갑니다.</span>`);
    const um = Object.entries(unmapped);
    if (um.length) li.push(`<span style="color:var(--crit)">계정 매핑이 없는 원가요소 ${um.length}개 (기능영역별): ${esc(um.slice(0, 8).map(([k, v]) => `${k} ${v.name || ''}(${v.n}행)`).join(', '))}${um.length > 8 ? ' …' : ''} — 저장은 되지만 gl_acct_map 에 추가해야 손익 계정에 반영됩니다.</span>`);
    box.innerHTML = h + '<ul class="upnote">' + li.map(x => `<li>${x}</li>`).join('') + '</ul>';
    msg.textContent = ''; $('upSave').disabled = false;
  } catch (e) { msg.textContent = '읽기 실패: ' + (e.message || e); msg.className = 'plan-msg err'; }
}
async function glSave() {
  if (U.busy || !U.rows.length) return;
  U.busy = true; $('upSave').disabled = true;
  const msg = $('upMsg'), bar = $('upBar');
  const fail = t => { msg.textContent = t; msg.className = 'plan-msg err'; U.busy = false; $('upSave').disabled = false; };
  try {
    const yms = [...new Set(U.rows.map(r => r.ym))].sort();
    for (const [i, y] of yms.entries()) {
      msg.textContent = `기존 ${y} 전표 정리 중… (${i + 1}/${yms.length})`; msg.className = 'plan-msg';
      const { error } = await sb.from('gl_voucher').delete().eq('ym', y);
      if (error) return fail('기존 전표 삭제 실패: ' + error.message);
    }
    const rec = r => ({ ym: r.ym, posted: r.posted, doc_no: r.hide ? null : r.doc, cost_center: r.cc, acct_code: r.acct, func: r.func, amount: r.amount, text: r.hide ? null : r.text, part: r.part, store_code: r.store });
    const N = U.rows.length, CH = 1000;
    for (let i = 0; i < N; i += CH) {
      const { error } = await sb.from('gl_voucher').insert(U.rows.slice(i, i + CH).map(rec));
      if (error) return fail(`저장 실패(${i + 1}행 부근): ${error.message} — 같은 파일을 다시 올리면 해당 월을 처음부터 교체합니다.`);
      bar.style.width = Math.round(Math.min(N, i + CH) / N * 100) + '%';
      msg.textContent = `저장 중… ${Math.min(N, i + CH).toLocaleString('ko-KR')} / ${N.toLocaleString('ko-KR')}`;
    }
    const names = {}; for (const r of U.rows) if (r.ccName) names[r.cc] = r.ccName;
    const { error: e2 } = await sb.from('gl_cc_names').upsert(Object.entries(names).map(([cost_center, name]) => ({ cost_center, name })), { onConflict: 'cost_center' });
    if (e2) return fail('코스트센터 이름 저장 실패: ' + e2.message);
    S.gl = {}; S.glAlloc = null;                 // 캐시 비우기 → 실적 추이가 새 전표로 다시 계산된다
    msg.textContent = `저장했습니다 — 전표 ${N.toLocaleString('ko-KR')}행 (${yms[0]} ~ ${yms[yms.length - 1]}). "실적 추이"에서 확인하세요.`; msg.className = 'plan-msg ok';
    U.rows = []; U.busy = false; $('upFile').value = '';
  } catch (e) { fail('저장 실패: ' + (e.message || e)); }
}
