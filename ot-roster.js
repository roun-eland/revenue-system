// 로운 생산성 — 정직원 맨파워 파서 (순수 함수, 브라우저·node 공용)
// "로운 N월 맨파워 현황" 엑셀(매장 × 직급 칸에 이름이 적힌 표)을 매장×직급별 인원수로 접는다.
// 개인정보 원칙: 이름·전화번호는 이 함수 안에서 개수를 세는 데만 쓰고 결과에 남기지 않는다.

const ROSTER_GRADES = ['선임점장', '점장', '부점장', 'GM', '매니저', '캡틴', '헤드', 'ST', 'TM', 'HIT'];
// 매장명 키워드 → 코드 (코드 칸이 비었거나 오타일 때 폴백). '동부산'을 '부산대'보다 먼저 검사할 필요는 없지만 겹침 방지로 구체적인 것 우선.
const ROSTER_NAME_KEYS = [['동부산', 'RU046'], ['부산대', 'RU041'], ['신촌', 'RU019'], ['청량리', 'RU025'], ['평촌', 'RU029'],
  ['수원', 'RU030'], ['중앙로', 'RU031'], ['강서', 'RU032'], ['일산', 'RU033'], ['송파', 'RU034'], ['순천', 'RU035'],
  ['괴정', 'RU037'], ['야탑', 'RU038'], ['광주역', 'RU039'], ['동탄', 'RU042'], ['의정부', 'RU043'], ['해운대', 'RU044'], ['광명', 'RU045']];
const ROSTER_VACANT = new Set(['', '-', '–', 'x', 'X', '공석', '(공석)', '결원', '없음', 'tbd', 'TBD', '0', 'N/A', 'n/a']);

// 칸 하나에 이름이 몇 명 적혀 있는지 (줄바꿈·쉼표·슬래시·가운뎃점·공백 구분) — 이름 자체는 반환하지 않고 정규화한 목록만 내부용으로 돌려준다.
function rosterSplitNames(cell) {
  return String(cell == null ? '' : cell).split(/[\n\r,;\/·、]+|\s+/).map(s => s.trim())
    .filter(s => !ROSTER_VACANT.has(s));
}

// 'RU0042' → 'RU042', 'RU32' → 'RU032'. 형식이 아니면 null
function rosterNormCode(v) {
  const m = String(v == null ? '' : v).trim().toUpperCase().match(/^RU0*(\d{1,3})$/);
  return m ? 'RU' + m[1].padStart(3, '0') : null;
}

// rows: sheet_to_json(header:1) 결과(2차원 배열). validCodes: 등록된 매장코드 Set.
// 반환: { stores: [{code, name, counts, total, headcountCell, warnings:[]}], notes:[], errors:[] }
function parseRoster(rows, validCodes) {
  const out = { stores: [], notes: [], errors: [] };
  const norm = v => String(v == null ? '' : v).replace(/\s+/g, '');
  // 1) 헤더 행 찾기: '매장코드'·'매장명'이 함께 있는 행 (FOH/BOH 그룹 행은 그 위)
  const hi = rows.findIndex(r => r.some(c => norm(c) === '매장코드') && r.some(c => norm(c) === '매장명'));
  if (hi < 0) { out.errors.push("헤더(매장코드·매장명)를 찾지 못했습니다 — '맨파워 현황' 원본인지 확인해주세요."); return out; }
  const hdr = rows[hi].map(norm);
  const cCode = hdr.indexOf('매장코드'), cName = hdr.indexOf('매장명');
  const cSenior = hdr.indexOf('선임점장'), cCnt = hdr.indexOf('인원수');
  const cLead = hdr.findIndex((c, i) => c === '점장' && i > Math.max(cName, cCnt));
  if (cLead < 0) { out.errors.push("'점장' 열을 찾지 못했습니다."); return out; }
  // 2) 직급 열: 점장 열 + 그 오른쪽으로 '전화'가 나오기 전까지(FOH·BOH 양쪽에 같은 직급이 반복됨)
  // FOH/BOH 그룹 행(헤더 바로 위): BOH 열부터가 주방. 점장 열은 FOH. 그룹 행이 없으면 홀/주방 구분은 계산하지 않는다.
  const grp = hi > 0 ? rows[hi - 1].map(norm) : [];
  const cBoh = grp.indexOf('BOH');
  const sideOf = col => (cBoh >= 0 ? (col >= cBoh ? 'boh' : 'foh') : null);
  const gradeCols = [{ col: cLead, grade: '점장', side: sideOf(cLead) }];
  for (let i = cLead + 1; i < hdr.length; i++) {
    if (hdr[i].includes('전화') || hdr[i].includes('선임관리자')) break;
    if (ROSTER_GRADES.includes(hdr[i])) gradeCols.push({ col: i, grade: hdr[i], side: sideOf(i) });
    else if (hdr[i]) out.notes.push(`인식하지 못한 직급 열 '${rows[hi][i]}' 은(는) 건너뜁니다.`);
  }
  if (gradeCols.length < 2) { out.errors.push('직급 열(GM·매니저·캡틴·헤드 등)을 찾지 못했습니다.'); return out; }

  // 3) 데이터 행
  const parsed = []; // 겸직 처리를 위해 점장 이름을 잠시 보관(결과에는 남기지 않음)
  const seen = new Set();
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r];
    const rawName = String(row[cName] == null ? '' : row[cName]).trim();
    if (!rawName) continue;
    let code = rosterNormCode(row[cCode]), fix = null;
    if (code && !validCodes.has(code)) code = null;
    if (!code) {
      const hit = ROSTER_NAME_KEYS.find(([k]) => rawName.includes(k));
      code = hit ? hit[1] : null;
      if (code) fix = String(row[cCode] || '').trim() ? `매장코드 '${String(row[cCode]).trim()}'가 올바르지 않아 매장명으로 ${code}에 매칭` : `매장코드가 비어 있어 매장명으로 ${code}에 매칭`;
    } else if (String(row[cCode]).trim().toUpperCase() !== code) {
      fix = `매장코드 '${String(row[cCode]).trim()}' → ${code} 자동 보정`;
    }
    if (!code || !validCodes.has(code)) { out.notes.push(`'${rawName}' 행은 매장을 식별하지 못해 건너뜁니다.`); continue; }
    if (seen.has(code)) { out.notes.push(`${code}가 파일에 두 번 있어 뒤의 행은 건너뜁니다.`); continue; }
    seen.add(code);
    const counts = {}; let total = 0;
    const side = { foh: 0, boh: 0 }; // 홀 관리자(FOH)·주방 관리자(BOH) 인원 — 이름은 세기만 하고 버린다
    const names = {}; // 직급 → 이름 목록 (겸직 판별용, 임시)
    for (const { col, grade, side: sd } of gradeCols) {
      const ns = rosterSplitNames(row[col]);
      if (!ns.length) continue;
      if (sd) side[sd] += ns.length;
      counts[grade] = (counts[grade] || 0) + ns.length;
      (names[grade] = names[grade] || []).push(...ns);
      total += ns.length;
    }
    const seniorNames = cSenior >= 0 ? rosterSplitNames(row[cSenior]) : [];
    const cell = cCnt >= 0 ? Math.round(Number(String(row[cCnt]).replace(/,/g, ''))) : NaN;
    parsed.push({ code, name: rawName, counts, total, side: cBoh >= 0 ? side : null, names, seniorNames, headcountCell: isFinite(cell) ? cell : null, warnings: fix ? [fix] : [] });
  }
  if (!parsed.length) { out.errors.push('매장 행을 찾지 못했습니다.'); return out; }

  // 4) 점장 = 선임점장 본인이면 직급을 '선임점장'으로
  for (const p of parsed) {
    const lead = (p.names['점장'] || [])[0];
    if (lead && p.seniorNames.includes(lead)) {
      p.counts['점장'] = (p.counts['점장'] || 0) - 1;
      if (p.counts['점장'] <= 0) delete p.counts['점장'];
      p.counts['선임점장'] = (p.counts['선임점장'] || 0) + 1;
      p.warnings.push('점장이 선임점장 본인 → 선임점장 직급으로 계산');
    }
  }
  // 5) 겸직: 같은 사람이 여러 매장의 점장/선임점장 칸에 있으면 한 곳에만 급여 반영 — 이름 수가 인원수 칸보다 많은 매장에서 뺀다
  const leadOf = {};
  for (const p of parsed) for (const n of (p.names['점장'] || [])) (leadOf[n] = leadOf[n] || []).push(p);
  for (const [, ps] of Object.entries(leadOf)) {
    if (ps.length < 2) continue;
    const excess = ps.filter(p => p.headcountCell != null && p.total > p.headcountCell);
    let drop = excess.length ? excess : ps.slice(1);
    if (drop.length >= ps.length) drop = ps.slice(1); // 전부 초과면 첫 매장만 유지
    for (const p of drop) {
      const g = p.counts['선임점장'] ? '선임점장' : '점장';
      p.counts[g] = (p.counts[g] || 0) - 1;
      if (p.counts[g] <= 0) delete p.counts[g];
      p.total -= 1;
      if (p.side) p.side.foh = Math.max(0, p.side.foh - 1); // 점장 열은 FOH
      p.warnings.push(`같은 사람이 ${ps.length}개 매장 점장으로 적혀 있어 이 매장에서는 제외(인원수 칸 기준, 급여 이중 계산 방지)`);
    }
  }
  // 6) 인원수 칸과 비교
  for (const p of parsed) {
    if (p.headcountCell != null && p.headcountCell !== p.total) p.warnings.push(`인원수 칸 ${p.headcountCell}명 ≠ 이름 수 ${p.total}명 — 이름이 적힌 직급 기준으로 계산`);
    delete p.names; delete p.seniorNames; // 이름은 여기서 폐기
    out.stores.push(p);
  }
  out.stores.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

// 저장용 행: {ym, store_code, grade, headcount} (인원 0은 제외)
function rosterToDbRows(ym, parsedStores) {
  const rows = [];
  for (const s of parsedStores) for (const g of ROSTER_GRADES) if ((s.counts[g] || 0) > 0)
    rows.push({ ym, store_code: s.code, grade: g, headcount: s.counts[g] });
  return rows;
}

// 홀/주방 관리자 인원 저장용 행: {ym, store_code, foh, boh}
function rosterToSideRows(ym, parsedStores) {
  return parsedStores.filter(s => s.side).map(s => ({ ym, store_code: s.code, foh: s.side.foh, boh: s.side.boh }));
}

if (typeof module !== 'undefined') module.exports = { parseRoster, rosterToDbRows, rosterToSideRows, rosterSplitNames, rosterNormCode, ROSTER_GRADES };
