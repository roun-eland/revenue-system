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

function exSheetNameFrom(table, fallback) {
  const raw = table.id || fallback || '표';
  const name = String(raw).replace(/[\\/?*[\]:]/g, '').slice(0, 31);
  return name || '표';
}

// container(엘리먼트 또는 CSS 선택자) 안의 table을 전부 모아 하나의 xlsx로 받는다.
function downloadTablesAsExcel(container, filenameBase) {
  if (typeof XLSX === 'undefined') { alert('엑셀 라이브러리가 아직 로드되지 않았습니다. 잠시 후 다시 시도해주세요.'); return; }
  const root = typeof container === 'string' ? document.querySelector(container) : container;
  if (!root) { alert('다운로드할 영역을 찾을 수 없습니다.'); return; }
  const tables = [...root.querySelectorAll('table')].filter(t => t.rows.length && t.offsetParent !== null);
  if (!tables.length) { alert('다운로드할 표가 비어 있습니다.'); return; }
  const wb = XLSX.utils.book_new();
  const used = new Set();
  tables.forEach((table, i) => {
    const aoa = exTableToAoa(table);
    if (!aoa.length) return;
    const name = exSheetNameFrom(table, `표${i + 1}`);
    let unique = name, n = 2;
    while (used.has(unique)) { unique = `${name}_${n++}`.slice(0, 31); }
    used.add(unique);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, unique);
  });
  if (!wb.SheetNames.length) { alert('다운로드할 표가 비어 있습니다.'); return; }
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  XLSX.writeFile(wb, `${filenameBase}_${stamp}.xlsx`);
}
