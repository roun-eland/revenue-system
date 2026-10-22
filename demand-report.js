// 로운 수요 — 4단계 월간 리포트 화면 (demand.js 뒤에 로드: sb, $, esc, num, invokeFn, showView 등을 같이 쓴다)
// 흐름: 서버가 만든 '초안'(숫자 + 자동 요점 + AI 해설)을 기획자가 고쳐 쓰고 승인하면 게시. 엑셀 원자료는 브라우저에서 바로 만든다.

let RP_LIST = [];
let RP_CUR = null;
const RP_STATUS = { draft: ['초안', 'new'], approved: ['승인·게시', 'ok'] };

async function rpLoadList() {
  const { data } = await sb.from('demand_reports').select('ym,status,title,generated_at,approved_at').order('ym', { ascending: false });
  RP_LIST = data || [];
}
const rpPrevYm = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

window.renderReportBox = async function () {
  if (!$('rpMonth')) return;
  try { await rpLoadList(); } catch (e) { $('rpBody').innerHTML = `<div class="empty">리포트 목록을 불러오지 못했습니다: ${esc(e.message)}</div>`; return; }
  const cur = $('rpMonth').value;
  const months = [...new Set([...RP_LIST.map(r => r.ym), rpPrevYm()])].sort().reverse();
  const pick = months.includes(cur) ? cur : (RP_LIST.find(r => r.status === 'approved') || RP_LIST[0] || { ym: rpPrevYm() }).ym;
  $('rpMonth').innerHTML = months.map(m => `<option value="${m}"${m === pick ? ' selected' : ''}>${m}${RP_LIST.find(r => r.ym === m) ? '' : ' (미생성)'}</option>`).join('');
  await rpShow(pick);
};

async function rpShow(ym) {
  const { data } = await sb.from('demand_reports').select('*').eq('ym', ym).maybeSingle();
  RP_CUR = data || null;
  const st = RP_CUR ? RP_STATUS[RP_CUR.status] : null;
  $('rpStatus').innerHTML = st ? `<span class="chip ${st[1]}">${st[0]}</span> <span class="dnote" style="display:inline">생성 ${esc((RP_CUR.generated_at || '').slice(0, 16).replace('T', ' '))}${RP_CUR.approved_at ? ' · 승인 ' + esc(RP_CUR.approved_at.slice(0, 10)) + ' ' + esc(RP_CUR.approved_by || '') : ''}</span>` : '<span class="chip">없음</span>';
  const draft = RP_CUR && RP_CUR.status === 'draft';
  $('rpGen').textContent = RP_CUR ? (RP_CUR.status === 'approved' ? '다시 생성(승인 해제)' : '다시 생성') : '초안 생성';
  $('rpSave').hidden = !draft; $('rpApprove').hidden = !draft; $('rpUnapprove').hidden = !(RP_CUR && RP_CUR.status === 'approved');
  $('rpXlsx').hidden = !RP_CUR;
  $('rpBody').innerHTML = RP_CUR ? rpHtml(RP_CUR, draft) : `<div class="empty">${esc(ym)} 월간 리포트가 아직 없습니다. 오른쪽 위 <b>초안 생성</b>을 누르면 이 달의 검색·고객 반응·점포 데이터로 초안을 만듭니다.<br>매월 2일 오전에 지난달 초안이 자동으로 만들어지며, 승인 전에는 '초안'으로만 표시됩니다.</div>`;
}

const rpLines = v => (Array.isArray(v) ? v : []).join('\n');
function rpTa(id, v, rows) { return `<textarea id="${id}" rows="${rows}" style="width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:6px 8px;border:1px solid #cfcfcf;border-radius:4px">${esc(v || '')}</textarea>`; }
function rpHtml(r, draft) {
  const d = r.data || {}, n = r.narrative || {}, ins = n.insights || {};
  const sec = (title, inner) => `<div style="margin:14px 0 4px"><div style="font-weight:700;margin-bottom:4px">${title}</div>${inner}</div>`;
  const list = a => `<ul style="margin:0;padding-left:18px;line-height:1.7">${(a || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const noAi = !r.narrative ? '<div class="dnote">AI 해설이 없는 초안입니다(무료 한도 소진 등). 아래 자동 요점은 숫자에서 규칙으로 뽑은 것이고, 해설은 직접 써 넣으실 수 있습니다.</div>' : `<div class="dnote">AI 해설(${esc(r.model || '')})은 초안입니다. 숫자는 아래 표와 대조해 확인하시고 고쳐 쓴 뒤 승인하세요.</div>`;
  const head = draft
    ? sec('총평(한 문장)', rpTa('rpHeadline', n.headline, 2)) + sec('핵심 요약(한 줄에 하나)', rpTa('rpSummary', rpLines(n.summary), 6))
    : (n.headline ? `<div style="font-size:16px;font-weight:700;margin:6px 0">${esc(n.headline)}</div>` : '') + (n.summary && n.summary.length ? list(n.summary) : '');
  const insBlock = draft
    ? sec('검색·관심도 해석', rpTa('rpInsSearch', ins.search, 3)) + sec('고객 반응 해석', rpTa('rpInsVoice', ins.voice, 3)) + sec('점포·규모 해석', rpTa('rpInsStores', ins.stores, 3)) + sec('주의·리스크(한 줄에 하나)', rpTa('rpRisks', rpLines(n.risks), 3)) + sec('점검·검토 제안(한 줄에 하나)', rpTa('rpActions', rpLines(n.actions), 4))
    : [['검색·관심도', ins.search], ['고객 반응', ins.voice], ['점포·규모', ins.stores]].filter(x => x[1]).map(x => sec(x[0], `<div style="line-height:1.7">${esc(x[1])}</div>`)).join('') + ((n.risks || []).length ? sec('주의·리스크', list(n.risks)) : '') + ((n.actions || []).length ? sec('점검·검토 제안', list(n.actions)) : '');
  const sb2 = d.search || {};
  const tbl = (cols, rows) => `<div class="tblwrap"><table><thead><tr>${cols.map(c => `<th${c[1] ? ' class="l"' : ''}>${c[0]}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const mom = v => v == null ? '—' : `<span class="${v >= 0 ? 'up' : 'dn'}">${v >= 0 ? '+' : ''}${v}%</span>`;
  const t1 = tbl([['순위'], ['브랜드', 1], ['검색 키워드', 1], ['월 검색수'], ['전월 대비']], (sb2.brands || []).map(b => `<tr${b.kind === 'own' ? ' style="background:#f3fbe7"' : ''}><td>${b.rank}</td><td class="l"><b>${esc(b.name)}</b></td><td class="l">${esc(b.keyword)}</td><td>${num(b.total)}${b.actual ? '' : ' <span class="chip">추정</span>'}</td><td>${mom(b.mom)}</td></tr>`));
  const t2 = tbl([['키워드', 1], ['월 검색수'], ['전월 대비']], [...(sb2.market || []), ...(sb2.needs || [])].map(k => `<tr><td class="l">${esc(k.keyword)}</td><td>${num(k.total)}${k.actual ? '' : ' <span class="chip">추정</span>'}</td><td>${mom(k.mom)}</td></tr>`));
  const t3 = (sb2.rising || []).length ? tbl([['기준 키워드', 1], ['연관어', 1], ['월 검색수'], ['전월 대비']], sb2.rising.map(x => `<tr><td class="l">${esc(x.base)}</td><td class="l">${esc(x.related)}</td><td>${num(x.total)}</td><td>${x.mom == null ? '<span class="chip new">신규</span>' : mom(x.mom)}</td></tr>`)) : '<div class="dnote">이번 달 급상승·신규 연관어가 없습니다.</div>';
  const t4 = tbl([['브랜드', 1], ['표본'], ['부정 비중'], ['전월'], ['한 줄 요약', 1], ['주의 신호', 1]], (d.voice || []).map(v => `<tr><td class="l"><b>${esc(v.name)}</b></td><td>${num(v.sample_size)}건${(v.sample_size || 0) < 8 ? ' <span class="chip new">부족</span>' : ''}</td><td>${v.neg_pct == null ? '—' : v.neg_pct + '%'}</td><td>${v.neg_pct_prev == null ? '—' : v.neg_pct_prev + '%'}</td><td class="l" style="white-space:normal">${esc(v.headline || '')}</td><td class="l" style="white-space:normal">${esc((v.flags || []).join('; '))}</td></tr>`));
  const t5 = tbl([['브랜드', 1], ['점포 수'], ['가맹'], ['직영'], ['증감'], ['출처·기준', 1]], (d.stores || []).map(s => `<tr><td class="l"><b>${esc(s.name)}</b></td><td>${s.total == null ? '—' : num(s.total)}</td><td>${s.total == null ? '—' : num(s.frcs)}</td><td>${s.total == null ? '—' : num(s.dms)}</td><td>${s.yoy == null ? '—' : (s.yoy >= 0 ? '+' : '') + s.yoy}</td><td class="l">${esc(s.source)}${s.period ? ' ' + esc(s.period) : ''}${s.avg_sales_ttm ? ' · 점포당 연매출 ' + (s.avg_sales_ttm / 1e8).toFixed(1) + '억' : ''}</td></tr>`));
  return `${noAi}${head}
    ${sec('자동 요점 (숫자에서 규칙으로 뽑은 사실)', list(r.highlights))}
    ${insBlock}
    ${sec('① 검색 — 브랜드별 월 검색수', t1)}${sec('② 검색 — 시장·메뉴 키워드', t2)}${sec('③ 급상승·신규 연관어', t3)}
    ${sec('④ 고객 반응 — 부정 비중', t4)}${sec('⑤ 점포 수', t5)}
    ${sec('한계·주의', list(d.limits))}`;
}

function rpCollect() {
  const g = id => ($(id) ? $(id).value : '');
  const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean);
  const n = { ...(RP_CUR.narrative || {}) };
  n.headline = g('rpHeadline').trim();
  n.summary = lines(g('rpSummary'));
  n.insights = { search: g('rpInsSearch').trim(), voice: g('rpInsVoice').trim(), stores: g('rpInsStores').trim() };
  n.risks = lines(g('rpRisks')); n.actions = lines(g('rpActions'));
  return n;
}
async function rpSaveEdits() {
  if (!RP_CUR || RP_CUR.status !== 'draft') return true;
  const n = rpCollect();
  const { error } = await sb.from('demand_reports').update({ narrative: n, edited_at: new Date().toISOString() }).eq('ym', RP_CUR.ym);
  if (error) { $('rpMsg').className = 'plan-msg err'; $('rpMsg').textContent = '저장 실패: ' + error.message; return false; }
  RP_CUR.narrative = n; return true;
}
const rpMsg = (t, cls = '') => { $('rpMsg').className = 'plan-msg ' + cls; $('rpMsg').textContent = t; };

$('rpMonth').onchange = () => rpShow($('rpMonth').value);
$('rpGen').onclick = async () => {
  const ym = $('rpMonth').value; const approved = RP_CUR && RP_CUR.status === 'approved';
  if (RP_CUR && !confirm(`${ym} 리포트를 다시 만들까요?\n지금까지 고친 내용${approved ? '과 승인 상태' : ''}이 새 초안으로 바뀝니다.`)) return;
  const btn = $('rpGen'); btn.disabled = true; rpMsg('초안 생성 중… (AI 해설 포함 1분 안팎)');
  try { const data = await invokeFn('demand-report', { ym, force: !!approved }); rpMsg(data.summary, 'ok'); await rpLoadList(); await window.renderReportBox(); }
  catch (e) { rpMsg('실패: ' + e.message, 'err'); } finally { btn.disabled = false; }
};
$('rpSave').onclick = async () => { if (await rpSaveEdits()) rpMsg('수정 내용을 저장했습니다.', 'ok'); };
$('rpApprove').onclick = async () => {
  if (!RP_CUR) return;
  if (!confirm(`${RP_CUR.ym} 리포트를 승인하고 게시할까요?\n(승인 후에도 '승인 해제'로 다시 고칠 수 있습니다.)`)) return;
  if (!(await rpSaveEdits())) return;
  const { data: { session } } = await sb.auth.getSession();
  const { error } = await sb.from('demand_reports').update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: session?.user?.email || '' }).eq('ym', RP_CUR.ym);
  if (error) return rpMsg('승인 실패: ' + error.message, 'err');
  rpMsg('승인·게시했습니다.', 'ok'); await window.renderReportBox();
};
$('rpUnapprove').onclick = async () => {
  if (!RP_CUR || !confirm('승인을 해제하고 초안으로 되돌릴까요?')) return;
  const { error } = await sb.from('demand_reports').update({ status: 'draft', approved_at: null, approved_by: null }).eq('ym', RP_CUR.ym);
  if (error) return rpMsg('해제 실패: ' + error.message, 'err');
  rpMsg('초안으로 되돌렸습니다.', 'ok'); await window.renderReportBox();
};
$('rpXlsx').onclick = () => { if (RP_CUR) { try { rpDownloadXlsx(RP_CUR); } catch (e) { rpMsg('엑셀 만들기 실패: ' + e.message, 'err'); } } };

// ---------- 엑셀(.xlsx) 직접 만들기: 라이브러리 없이 압축 없는(store) zip으로 묶는다 ----------
function rpDownloadXlsx(r) {
  const d = r.data || {}, n = r.narrative || {}, s = d.search || {};
  const stat = r.status === 'approved' ? '승인·게시' : '초안';
  const sheets = [
    { name: '요약', widths: [16, 110], rows: [
      ['제목', r.title], ['상태', stat], ['생성', (r.generated_at || '').slice(0, 16).replace('T', ' ')], ['총평', n.headline || ''],
      ...(n.summary || []).map((x, i) => [i ? '' : '핵심 요약', x]),
      ...(r.highlights || []).map((x, i) => [i ? '' : '자동 요점', x]),
      ['검색 해석', (n.insights || {}).search || ''], ['고객 반응 해석', (n.insights || {}).voice || ''], ['점포 해석', (n.insights || {}).stores || ''],
      ...(n.risks || []).map((x, i) => [i ? '' : '주의·리스크', x]), ...(n.actions || []).map((x, i) => [i ? '' : '점검·검토 제안', x]),
    ] },
    { name: '검색_브랜드', widths: [8, 18, 22, 14, 14, 14, 10], header: true, rows: [['순위', '브랜드', '키워드', '월 검색수', '전월', '전월 대비(%)', '구분'],
      ...(s.brands || []).map(b => [b.rank, b.name, b.keyword, b.total, b.prev, b.mom, b.actual ? '실측' : '추정'])] },
    { name: '검색_키워드', widths: [24, 14, 14, 14, 10], header: true, rows: [['키워드', '월 검색수', '전월', '전월 대비(%)', '구분'],
      ...[...(s.market || []), ...(s.needs || [])].map(k => [k.keyword, k.total, k.prev, k.mom, k.actual ? '실측' : '추정'])] },
    { name: '급상승_연관어', widths: [20, 24, 14, 14, 14], header: true, rows: [['기준 키워드', '연관어', '월 검색수', '전월', '전월 대비(%)'],
      ...(s.rising || []).map(x => [x.base, x.related, x.total, x.prev, x.mom == null ? '신규' : x.mom])] },
    { name: '고객반응', widths: [16, 12, 12, 12, 12, 12, 60, 50, 50, 40], header: true, rows: [['브랜드', '수집 글', '표본', '부정 항목', '부정 비중(%)', '전월(%)', '한 줄 요약', '좋다는 반응', '아쉽다는 반응', '주의 신호'],
      ...(d.voice || []).map(v => [v.name, v.n_items, v.sample_size, v.neg_items, v.neg_pct, v.neg_pct_prev, v.headline || '',
        (v.positives || []).map(x => `${x.theme}(${x.count})`).join(', '), (v.negatives || []).map(x => `${x.theme}(${x.count})`).join(', '), (v.flags || []).join('; ')])] },
    { name: '점포', widths: [16, 12, 10, 10, 10, 22, 12, 16, 16], header: true, rows: [['브랜드', '점포 수', '가맹', '직영', '증감', '출처', '기준', '점포당 연매출(원)', '최근12개월 신규'],
      ...(d.stores || []).map(x => [x.name, x.total, x.frcs, x.dms, x.yoy, x.source, x.period || '', x.avg_sales_ttm || '', x.open_12m ?? ''])] },
    { name: '한계', widths: [120], rows: (d.limits || []).map(x => [x]) },
  ];
  const blob = xlsxBlob(sheets);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `로운_시장경쟁사_월간리포트_${r.ym}.xlsx`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function xlsxBlob(sheets) {
  const enc = new TextEncoder();
  const X = s => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = i => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
  const sheetXml = sh => {
    const cols = sh.widths ? `<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const rows = sh.rows.map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => {
      const ref = col(ci) + (ri + 1), bold = (sh.header && ri === 0) || (!sh.header && ci === 0 && String(v || '') !== '');
      if (v == null || v === '') return bold ? `<c r="${ref}" s="1"/>` : '';
      if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${bold ? ' s="1"' : ''}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ' s="2"'}><is><t xml:space="preserve">${X(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sh.header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : ''}${cols}<sheetData>${rows}</sheetData></worksheet>`;
  };
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${X(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="맑은 고딕"/></font><font><b/><sz val="10"/><name val="맑은 고딕"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ].map(([name, text]) => ({ name, data: enc.encode(text) }));
  // zip(store)
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const parts = [], central = []; let offset = 0;
  const u16 = n => [n & 255, (n >> 8) & 255], u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const local = new Uint8Array([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(size), ...u32(size), ...u16(nm.length), ...u16(0)]);
    parts.push(local, nm, f.data);
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(size), ...u32(size), ...u16(nm.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), nm);
    offset += local.length + nm.length + size;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), 0, 0]);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
