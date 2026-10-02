// 탭/서브탭 단위 "엑셀 다운로드" 공용 헬퍼 — 매출·생산성·원가·고객 4개 앱이 공유한다 (2026-10-02).
// 각 화면은 버튼 하나당 downloadTablesAsExcel(container, filenameBase)만 호출하면 된다.
// container 안에 있는 <table>을 전부 찾아 각각 별도 시트로 변환해 워크북 1개로 받는다.
// rowspan/colspan은 값을 펴서 채워서, 화면에 보이는 셀 그대로 엑셀에 나온다(합쳐진 헤더도 반복 표시).

function exTableToAoa(table) {
  const rows = [...table.rows];
  if (!rows.length) return [];
  let nCols = 0;
  rows.forEach(r => { let c = 0; [...r.cells].forEach(cell => c += (cell.colSpan || 1)); nCols = Math.max(nCols, c); });
  if (!nCols) return [];
  const grid = Array.from({ length: rows.length }, () => new Array(nCols).fill(''));
  const occupied = Array.from({ length: rows.length }, () => new Array(nCols).fill(false));
  rows.forEach((row, r) => {
    let c = 0;
    [...row.cells].forEach(cell => {
      while (c < nCols && occupied[r][c]) c++;
      const rowSpan = cell.rowSpan || 1, colSpan = cell.colSpan || 1;
      const text = (cell.innerText ?? cell.textContent ?? '').replace(/\s+/g, ' ').trim();
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < rows.length && cc < nCols) { grid[rr][cc] = text; occupied[rr][cc] = true; }
        }
      }
      c += colSpan;
    });
  });
  return grid;
}

function exSheetNameFrom(nameOrTable, fallback) {
  const raw = (typeof nameOrTable === 'string' ? nameOrTable : nameOrTable?.id) || fallback || '표';
  const name = String(raw).replace(/[\\/?*[\]:]/g, '').slice(0, 31);
  return name || '표';
}

function exUniqueSheetName(name, used) {
  let unique = name, n = 2;
  while (used.has(unique)) { unique = `${name}_${n++}`.slice(0, 31); }
  used.add(unique);
  return unique;
}

function exDateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// container 안의 table들을 [[시트명, aoa], ...] 쌍으로 모은다 — downloadTablesAsExcel 내부용이지만,
// 표+커스텀 레이아웃을 한 파일에 같이 담고 싶을 때(예: downloadAoaAsExcel에 합쳐서) 직접 써도 된다.
function collectTableSheetPairs(container) {
  const root = typeof container === 'string' ? document.querySelector(container) : container;
  if (!root) return [];
  const tables = [...root.querySelectorAll('table')].filter(t => t.rows.length && t.offsetParent !== null);
  return tables.map((table, i) => [exSheetNameFrom(table, `표${i + 1}`), exTableToAoa(table)]).filter(([, aoa]) => aoa.length);
}

// container(엘리먼트 또는 CSS 선택자) 안의 table을 전부 모아 하나의 xlsx로 받는다.
function downloadTablesAsExcel(container, filenameBase) {
  if (typeof XLSX === 'undefined') { alert('엑셀 라이브러리가 아직 로드되지 않았습니다. 잠시 후 다시 시도해주세요.'); return; }
  const root = typeof container === 'string' ? document.querySelector(container) : container;
  if (!root) { alert('다운로드할 영역을 찾을 수 없습니다.'); return; }
  const pairs = collectTableSheetPairs(root);
  if (!pairs.length) { alert('다운로드할 표가 비어 있습니다.'); return; }
  downloadAoaAsExcel(pairs, filenameBase);
}

// <table> DOM이 아니라 직접 만든 2차원 배열(aoa)을 시트로 받고 싶을 때 쓴다 — 리뷰 카드 목록처럼
// 화면이 table이 아닌 커스텀 레이아웃인 경우용. sheets: [[시트명, aoa], ...] 배열.
function downloadAoaAsExcel(sheets, filenameBase) {
  if (typeof XLSX === 'undefined') { alert('엑셀 라이브러리가 아직 로드되지 않았습니다. 잠시 후 다시 시도해주세요.'); return; }
  const valid = (sheets || []).filter(([, aoa]) => aoa && aoa.length);
  if (!valid.length) { alert('다운로드할 내용이 없습니다.'); return; }
  const wb = XLSX.utils.book_new();
  const used = new Set();
  valid.forEach(([name, aoa], i) => {
    const unique = exUniqueSheetName(exSheetNameFrom(name, `표${i + 1}`), used);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), unique);
  });
  XLSX.writeFile(wb, `${filenameBase}_${exDateStamp()}.xlsx`);
}
