// 로운 매장정보 — 매장별 기본·임차 정보 (store_info). 기획자 전용(RLS도 기획자만).
// 임차료율·매장크기·좌석수가 핵심 — 예상실적(임차료·수도광열 등 추정)의 기준값으로 쓸 예정. 그 외 항목은 extra(jsonb)에 자유롭게 추가.

const SUPABASE_URL = 'https://mnqgqgwdoztdbdyhjqyo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_V7ZsNdBMXGHxodVvI6mOTw_MB8PapC2';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// [컬럼, 이름, 종류, 핵심 여부]  종류: t 글자 · n 소수 · i 정수 · d 날짜
const COLS = [
  ['store_code', '매장코드', 't'], ['store_name', '매장명', 't'],
  ['rent_rate', '임차료율(%)', 'n', 1], ['area_m2', '매장크기(㎡)', 'n', 1], ['seats', '좌석수', 'i', 1],
  ['contract_type', '계약구분', 't'], ['open_date', '오픈일자', 'd'], ['biz_site', '사업장', 't'], ['cost_center', '코스트센터', 't'],
  ['store_type', '매장구분', 't'], ['brand', '브랜드', 't'], ['biz_reg_no', '사업자등록번호', 't'],
  ['region', '지역', 't'], ['address', '상세주소', 't'], ['zip', '우편번호', 't'], ['phone', '전화번호', 't']
];
const isNum = t => t === 'n' || t === 'i';
const S = { rows: [], sort: { k: 'store_code', dir: 1 }, editing: null, email: '' };

async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.replace('../'); return; }
  S.email = session.user.email;
  $('loginView').hidden = true; $('appView').hidden = false;
  $('whoEmail').textContent = S.email;
  let role = 'planner';
  try {
    const { data } = await sb.from('ot_profiles').select('role').eq('user_id', session.user.id).maybeSingle();
    if (data && data.role) role = data.role;
  } catch (e) { /* 무시 */ }
  $('roleChip').textContent = role === 'planner' ? '기획자' : '매장 관리자';
  $('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.replace('../'); };
  if (role !== 'planner') {
    $('stNav').hidden = true;
    $('stMain').innerHTML = '<h2>매장정보</h2><p class="view-sub">매장 임차 정보는 기획자만 볼 수 있습니다.</p>';
    return;
  }
  $('stNew').onclick = () => openForm(null);
  $('stCancel').onclick = closeForm;
  $('stSave').onclick = save;
  await load();
}
$('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.replace('../'); };

async function load() {
  const { data, error } = await sb.from('store_info').select('*').order('store_code');
  if (error) { setMsg('불러오지 못했습니다: ' + error.message, true); return; }
  S.rows = data || [];
  render();
}
function setMsg(t, err) { const e = $('stMsg'); e.textContent = t || ''; e.className = 'plan-msg' + (err ? ' err' : t ? ' ok' : ''); }

// ---------- 표 ----------
const extraKeys = () => [...new Set(S.rows.flatMap(r => Object.keys(r.extra || {})))];
const fmt = (v, kind) => {
  if (v == null || v === '') return '<span class="z">-</span>';
  if (kind === 'i') return Number(v).toLocaleString('ko-KR');
  if (kind === 'n') return Number(v).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return esc(v);
};
function sorted() {
  const { k, dir } = S.sort;
  const kind = (COLS.find(c => c[0] === k) || [])[2];
  const val = r => k.startsWith('x:') ? (r.extra || {})[k.slice(2)] : r[k];
  return [...S.rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null || x === '') return 1;
    if (y == null || y === '') return -1;
    return (isNum(kind) ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'ko')) * dir;
  });
}
function render() {
  const rows = S.rows;
  const sum = f => rows.reduce((a, r) => a + (Number(r[f]) || 0), 0);
  const rent = rows.map(r => Number(r.rent_rate)).filter(x => x > 0);
  const avg = rent.length ? rent.reduce((a, b) => a + b, 0) / rent.length : 0;
  const gap = rows.filter(r => r.contract_type === '임대갑').length;
  $('stKpis').innerHTML = [
    ['매장 수', rows.length.toLocaleString('ko-KR') + '개', `임대갑 ${gap} · 임대을 ${rows.length - gap}`],
    ['좌석수 합계', sum('seats').toLocaleString('ko-KR') + '석', rows.length ? `매장당 평균 ${Math.round(sum('seats') / rows.length)}석` : ''],
    ['매장크기 합계', Math.round(sum('area_m2')).toLocaleString('ko-KR') + '㎡', rows.length ? `매장당 평균 ${Math.round(sum('area_m2') / rows.length)}㎡` : ''],
    ['평균 임차료율', avg.toFixed(2) + '%', '0% 매장(폐점) 제외 단순 평균']
  ].map(([k, v, s]) => `<div class="st-kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');

  const ex = extraKeys();
  const th = (key, name, cls) => `<th class="${cls}" data-k="${esc(key)}">${esc(name)}${S.sort.k === key ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  let h = '<table class="st"><thead><tr>' +
    COLS.map(([k, n, t, key]) => th(k, n, (isNum(t) ? 'num ' : '') + (key ? 'key' : ''))).join('') +
    ex.map(k => th('x:' + k, k, '')).join('') + '<th data-k="">&nbsp;</th></tr></thead><tbody>';
  for (const r of sorted()) {
    h += '<tr>' + COLS.map(([k, , t, key]) => {
      const zero = k === 'rent_rate' && Number(r[k]) === 0;
      return `<td class="${isNum(t) ? 'num' : ''}${key ? ' key' : ''}${zero ? ' z' : ''}">${fmt(r[k], t)}</td>`;
    }).join('') + ex.map(k => `<td>${fmt((r.extra || {})[k], 't')}</td>`).join('') +
      `<td class="act"><button type="button" data-edit="${esc(r.store_code)}">수정</button></td></tr>`;
  }
  $('stTable').innerHTML = h + '</tbody></table>';
  document.querySelectorAll('#stTable th[data-k]').forEach(t => {
    if (!t.dataset.k) return;
    t.onclick = () => { S.sort = { k: t.dataset.k, dir: S.sort.k === t.dataset.k ? -S.sort.dir : 1 }; render(); };
  });
  document.querySelectorAll('#stTable button[data-edit]').forEach(b => { b.onclick = () => openForm(b.dataset.edit); });
}

// ---------- 수정·추가 ----------
function openForm(code) {
  S.editing = code;
  const r = code ? S.rows.find(x => x.store_code === code) : {};
  $('stFormTitle').textContent = code ? `${r.store_name} (${code}) 수정` : '매장 추가';
  $('stForm').innerHTML = COLS.map(([k, n, t]) => {
    const v = r[k] == null ? '' : r[k];
    const ro = code && k === 'store_code' ? ' readonly' : '';
    const wide = k === 'address' || k === 'store_name' ? ' wide' : '';
    return `<label class="fld${wide}">${n}<input data-f="${k}" type="${t === 'd' ? 'date' : 'text'}"${isNum(t) ? ' inputmode="decimal"' : ''}${ro} value="${esc(v)}"></label>`;
  }).join('');
  $('stExtra').innerHTML = Object.entries(r.extra || {}).map(([k, v]) => `<label class="fld">${esc(k)}<input data-x="${esc(k)}" type="text" value="${esc(v)}"></label>`).join('');
  $('stNewKey').value = ''; $('stNewVal').value = '';
  $('stFormMsg').textContent = ''; $('stFormMsg').className = 'plan-msg';
  $('stFormCard').hidden = false;
  $('stFormCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function closeForm() { $('stFormCard').hidden = true; S.editing = null; }

function formErr(t) { const e = $('stFormMsg'); e.textContent = t; e.className = 'plan-msg err'; }

async function save() {
  const row = {};
  for (const [k, n, t] of COLS) {
    let v = document.querySelector(`#stForm [data-f="${k}"]`).value.trim();
    if (v === '') { row[k] = null; continue; }
    if (isNum(t)) {
      const x = Number(v.replace(/,/g, ''));
      if (!isFinite(x) || x < 0) return formErr(`${n}: 0 이상의 숫자를 입력하세요.`);
      if (t === 'i' && !Number.isInteger(x)) return formErr(`${n}: 정수를 입력하세요.`);
      if (k === 'rent_rate' && x > 100) return formErr('임차료율은 0~100(%) 사이로 입력하세요.');
      v = x;
    }
    if (t === 'd' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return formErr(`${n}: 날짜 형식(YYYY-MM-DD)이 아닙니다.`);
    row[k] = v;
  }
  if (!row.store_code) return formErr('매장코드를 입력하세요.');
  if (!row.store_name) return formErr('매장명을 입력하세요.');
  if (!S.editing && S.rows.some(r => r.store_code === row.store_code)) return formErr('이미 있는 매장코드입니다. 목록에서 "수정"을 사용하세요.');

  const base = S.editing ? S.rows.find(x => x.store_code === S.editing) : null;
  const extra = { ...((base && base.extra) || {}) };
  document.querySelectorAll('#stExtra [data-x]').forEach(el => { const v = el.value.trim(); if (v === '') delete extra[el.dataset.x]; else extra[el.dataset.x] = v; });
  const nk = $('stNewKey').value.trim(), nv = $('stNewVal').value.trim();
  if (nk && nv) extra[nk] = nv;
  else if (nk || nv) return formErr('새 항목은 이름과 값을 모두 입력하세요.');
  row.extra = extra; row.updated_at = new Date().toISOString(); row.updated_by = S.email;

  const { error } = await (S.editing ? sb.from('store_info').update(row).eq('store_code', S.editing) : sb.from('store_info').insert(row));
  if (error) return formErr('저장 실패: ' + error.message);
  const label = row.store_name;
  closeForm();
  await load();
  setMsg(`${label} 저장했습니다.`);
}

init();
