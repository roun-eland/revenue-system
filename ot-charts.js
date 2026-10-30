// 로운 생산성 — 표 점검 그래프 (2026-10-26)
//  · 전사 대시보드: 매출 대비 근무시간 / 인건비율 산점도 (표와 같은 행을 사용)
//  · 매장 피드백: 매장별 그래프(시간대별 표 vs 실제, 하루 근무시간 표/달성선/실제, 포지션별 편차)
// 달성선 = 그 매장의 일별 실적(8월~)에서 "근무시간 ~ 객수" 직선을 긋고, 잔차 하위 25%(잘 운영한 날)만큼 낮춘 선.
// 정답이 아니라 "그 매장이 실제로 해낸 수준"이며, 인원이 모자랐던 날도 섞일 수 있다 — 논의용 지표.
// ot.js·ot-actuals.js 뒤에 로드되어 그 전역(sb, $, OT_STD, OT_DATA, OT_HOLIDAYS, won, showView, loadFeedback)을 쓴다.

const OC = { ready: null, byStore: {}, an: null, scatter: null, fbCharts: [], scatterKey: '' };
const OC_COL = { ink: '#2F3030', green: '#3F9E12', orange: '#D9822B', blue: '#378ADD', red: '#D9534F', gray: '#9AA0A6' };
const OC_CATS = ['홀', '콜파트', '핫파트', '육절기', '프랩', 'DMO', '관리·기타'];
const OC_DT = { weekday: '평일', weekend: '주말' };
const ocMean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const ocMedian = a => { const v = a.filter(x => x != null).slice().sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const ocQuant = (a, p) => { const v = a.slice().sort((x, y) => x - y), i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return v[lo] + (v[hi] - v[lo]) * (i - lo); };
const ocDtOf = iso => { const d = new Date(iso + 'T00:00:00'), wd = (d.getDay() + 6) % 7; return (wd >= 5 || OT_HOLIDAYS.has(iso)) ? 'weekend' : 'weekday'; };

// ---------- 데이터 (8월~ 일별 근태·매출, 한 번만 불러와 재사용) ----------
async function ocPaged(table, cols, dateCol) {
  const out = [];
  for (let i = 0; ; i++) {
    const { data, error } = await sb.from(table).select(cols).gte(dateCol, '2026-08-01').order(dateCol).order('store_code').range(i * 1000, i * 1000 + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
function ocLoad() {
  if (OC.ready && Date.now() - OC.t < 600000) return OC.ready; // 10분 캐시 — 새 실적을 올린 뒤에도 곧 반영됨
  OC.t = Date.now();
  OC.ready = (async () => {
    const [lab, sal] = await Promise.all([
      ocPaged('ot_labor_daily', 'store_code,work_date,mate_mh,ft_mh,by_hour', 'work_date'),
      ocPaged('ot_sales_daily', 'store_code,sales_date,total,guests,is_closed', 'sales_date')]);
    const L = new Map(lab.map(r => [r.store_code + '|' + r.work_date, r]));
    OC.byStore = {};
    for (const r of sal) {
      if (r.is_closed || !(+r.total > 0)) continue;
      const l = L.get(r.store_code + '|' + r.sales_date); if (!l) continue;
      const mh = (+l.mate_mh || 0) + (+l.ft_mh || 0); if (!(mh > 0)) continue;
      (OC.byStore[r.store_code] = OC.byStore[r.store_code] || []).push({
        date: r.sales_date, ym: r.sales_date.slice(0, 7), dt: ocDtOf(r.sales_date), mh, sales: +r.total,
        guests: r.guests ? +r.guests : null, byHour: (l.by_hour || []).map(x => +x || 0) });
    }
    OC.an = ocAnalyze();
  })().catch(e => { OC.ready = null; throw e; });
  return OC.ready;
}

// ---------- 분석 (매장별 직선·기준 매출, 매장 간 비교 기준) ----------
const ocPlan = (code, dt) => (OT_STD[code] && OT_STD[code][dt]) ? OT_STD[code][dt].stats : null;
function ocCatMH(stats) { const o = {}; OC_CATS.forEach(c => { o[c] = (stats.cat[c] || []).reduce((s, x) => s + x, 0) / 2; }); return o; }
function ocHourMap(stats) { const m = {}; stats.hours.forEach(r => { m[r.h] = r.need; }); return m; }

function ocAnalyze() {
  const an = { st: {}, est: [], fit: null, medRatio: { weekday: {}, weekend: {} } };
  for (const code of Object.keys(OT_STD)) {
    const days = OC.byStore[code] || [], sep = days.filter(d => d.ym === '2026-09');
    const ref = {};
    for (const dt of ['weekday', 'weekend']) {
      const s = sep.filter(d => d.dt === dt), a = s.length >= 3 ? s : days.filter(d => d.dt === dt);
      ref[dt] = { n: s.length, sales: ocMean(a.map(d => d.sales)), guests: ocMean(a.filter(d => d.guests).map(d => d.guests)) };
    }
    const g = days.filter(d => d.guests);
    let reg = null;
    if (g.length >= 8) {
      const mx = ocMean(g.map(d => d.guests)), my = ocMean(g.map(d => d.mh));
      let sxy = 0, sxx = 0; g.forEach(d => { sxy += (d.guests - mx) * (d.mh - my); sxx += (d.guests - mx) ** 2; });
      const b = sxx ? sxy / sxx : 0, a = my - b * mx;
      const resid = g.map(d => d.mh - (a + b * d.guests));
      const ssTot = g.reduce((s, d) => s + (d.mh - my) ** 2, 0), ssRes = resid.reduce((s, x) => s + x * x, 0);
      const q25 = ocQuant(resid, 0.25);
      reg = { n: g.length, a, b, r2: ssTot ? 1 - ssRes / ssTot : 0, q25, af: a + q25 };
    }
    const nWd = sep.filter(d => d.dt === 'weekday').length, nWe = sep.filter(d => d.dt === 'weekend').length;
    const pw = ocPlan(code, 'weekday'), pe = ocPlan(code, 'weekend');
    an.st[code] = { ref, reg, nWd, nWe, sepSales: sep.reduce((s, d) => s + d.sales, 0), planMonth: pw && pe ? pw.totMH * nWd + pe.totMH * nWe : null };
  }
  // 기준 매장: 9월 한 달 영업 기록이 15일 이상인 매장 (신규 오픈점 제외)
  an.est = Object.keys(an.st).filter(c => an.st[c].nWd + an.st[c].nWe >= 15 && an.st[c].planMonth);
  if (an.est.length >= 3) {
    const xs = an.est.map(c => an.st[c].sepSales / 1e8), ys = an.est.map(c => an.st[c].planMonth);
    const mx = ocMean(xs), my = ocMean(ys); let sxy = 0, sxx = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
    const sl = sxx ? sxy / sxx : 0; an.fit = { sl, ic: my - sl * mx };
  }
  for (const dt of ['weekday', 'weekend'])
    for (const cat of OC_CATS)
      an.medRatio[dt][cat] = ocMedian(an.est.map(c => { const p = ocPlan(c, dt), r = an.st[c].ref[dt]; return p && r.sales ? ocCatMH(p)[cat] / (r.sales / 1e6) : null; }));
  return an;
}

// 한 매장·한 달 진단
function ocDiag(code, ym) {
  const A = OC.an.st[code]; if (!A) return null;
  const out = { code, dt: {} };
  for (const dt of ['weekday', 'weekend']) {
    const p = ocPlan(code, dt), r = A.ref[dt];
    const days = (OC.byStore[code] || []).filter(d => d.ym === ym && d.dt === dt);
    const act = days.length ? ocMean(days.map(d => d.mh)) : null;
    const front = (A.reg && r.guests) ? A.reg.af + A.reg.b * r.guests : null;
    const o = { plan: p.totMH, front, act, nAct: days.length, sales: r.sales, guests: r.guests,
      diff: front != null ? p.totMH - front : null, pct: front ? (p.totMH / front - 1) * 100 : null,
      aDiff: act != null ? act - p.totMH : null, aPct: act != null ? (act / p.totMH - 1) * 100 : null };
    const cm = ocCatMH(p), s = (r.sales || 0) / 1e6;
    o.dev = OC_CATS.map(c => ({ cat: c, mh: cm[c], dev: cm[c] - (OC.an.medRatio[dt][c] || 0) * s }));
    // 상시(영업시간 11~22시 시간대별 인원 하위 25%) / 피크
    const hm = ocHourMap(p), core = []; for (let h = 11; h < 22; h++) core.push(hm[h] || 0);
    o.baseN = ocQuant(core, 0.25); o.peakN = Math.max(...core); o.peakH = 11 + core.indexOf(o.peakN);
    out.dt[dt] = o;
  }
  const w = out.dt.weekday, e = out.dt.weekend, anyOf = (k, f) => [w, e].some(x => x[k] != null && f(x[k]));
  const resid = A.planMonth && OC.an.fit ? (A.planMonth / (OC.an.fit.ic + OC.an.fit.sl * A.sepSales / 1e8) - 1) * 100 : null;
  out.resid = resid;
  if (!OC.an.est.includes(code)) out.verdict = ['신규점(참고)', 'gray'];
  else if (anyOf('pct', v => v > 10)) out.verdict = ['표 점검 — 달성선보다 큼', 'orange'];
  else if (anyOf('aPct', v => v > 10) && anyOf('pct', v => v < -5)) out.verdict = ['표 현실화 — 실제가 표보다 많음', 'blue'];
  else if (anyOf('aPct', v => v > 10)) out.verdict = ['실제가 표보다 많음', 'blue'];
  else if (anyOf('pct', v => v < -5)) out.verdict = ['표가 빠듯', 'blue'];
  else out.verdict = ['적정 범위', 'green'];
  return out;
}

// ---------- 공통 차트 도구 ----------
function ocFontInit() { if (typeof Chart !== 'undefined') Chart.defaults.font.family = "'Noto Sans KR','Malgun Gothic',sans-serif"; }
const ocValueLabels = { id: 'ocValueLabels', afterDatasetsDraw(chart, _a, opts) {
  if (!opts || !opts.on) return;
  const ctx = chart.ctx; ctx.save(); ctx.font = '11px sans-serif'; ctx.fillStyle = '#131518';
  chart.data.datasets.forEach((ds, i) => chart.getDatasetMeta(i).data.forEach((el, j) => {
    const v = ds.data[j]; if (v == null || v === 0) return;
    const horiz = chart.options.indexAxis === 'y';
    const txt = horiz ? (v > 0 ? '+' : '') + v.toFixed(1) + 'h' : Math.round(v);
    if (horiz) { ctx.textAlign = v >= 0 ? 'left' : 'right'; ctx.textBaseline = 'middle'; ctx.fillText(txt, el.x + (v >= 0 ? 4 : -4), el.y); }
    else { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(txt, el.x, el.y - 3); }
  })); ctx.restore(); } };
function ocDestroyFb() { OC.fbCharts.forEach(c => c.destroy()); OC.fbCharts = []; }

// ---------- 전사 대시보드: 매출 대비 근무시간 / 인건비율 산점도 (조회 월의 실적·계획 행을 그대로 사용) ----------
// data = { rows: [{code, name, sales(원), mh, ratio(%)}], label: '10월 누적 (~10/19)' } — ot.js renderDash가 표와 같은 행을 넘겨 준다.
// 근무시간: 같은 매출에서 전사 평균(직선)보다 많이/적게 쓰는지. 인건비율: 24%/28%/상한 38% 기준선 대비 위치.
function ocMetric() { if (OC.met) return OC.met; try { const m = localStorage.getItem('oc_met'); return m === 'ratio' || m === 'prod' ? m : 'hours'; } catch (e) { return 'hours'; } }
function ocSetMetric(m) { OC.met = m; try { localStorage.setItem('oc_met', m); } catch (e) { /* 저장 불가여도 이 화면에서는 바뀐다 */ } ocRenderScatter(OC.scData); }
function ocLabelPlugin(pts, colorOf) {
  return { id: 'ocPtLabels', afterDatasetsDraw(chart) {
    const ctx = chart.ctx, area = chart.chartArea, els = chart.getDatasetMeta(0).data, placed = [], h = 13;
    ctx.save(); ctx.font = '12px sans-serif'; ctx.textBaseline = 'top';
    const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const dots = els.map(e => ({ x: e.x - 7, y: e.y - 7, w: 14, h: 14 }));
    for (const i of els.map((_, k) => k).sort((a, b) => els[a].x - els[b].x)) {
      const el = els[i], p = pts[i], w = ctx.measureText(p.name).width;
      const cand = [[8, -h - 2], [8, 3], [-8 - w, -h - 2], [-8 - w, 3], [-w / 2, -h - 9], [-w / 2, 9], [8, -h - 17], [8, 17], [-8 - w, -h - 17], [-8 - w, 17]];
      let pick = null;
      for (const [dx, dy] of cand) {
        const r = { x: el.x + dx, y: el.y + dy, w, h };
        if (r.x < area.left || r.x + w > area.right || r.y < area.top || r.y + h > area.bottom) continue;
        if (placed.some(q => hit(r, q)) || dots.some((d, j) => j !== i && hit(r, d))) continue;
        pick = r; break;
      }
      if (!pick) pick = { x: Math.min(Math.max(el.x + 8, area.left), area.right - w), y: Math.min(Math.max(el.y - h - 2, area.top), area.bottom - h), w, h };
      placed.push(pick); ctx.fillStyle = colorOf(p); ctx.fillText(p.name, pick.x, pick.y);
    }
    ctx.restore(); } };
}
function ocRenderScatter(data) {
  const card = $('dashScatterCard'); if (!card || typeof Chart === 'undefined') return;
  OC.scData = data;
  const rows = data && data.rows ? data.rows.filter(r => r.sales > 0 && r.mh > 0 && r.ratio != null && isFinite(r.ratio)) : [];
  if (rows.length < 3) { card.style.display = 'none'; return; }
  card.style.display = ''; ocFontInit();
  const met = ocMetric();
  [['ocMetHrs', 'hours'], ['ocMetRatio', 'ratio'], ['ocMetProd', 'prod']].forEach(([id, m]) => { const b = $(id); if (!b) return; b.style.background = m === met ? '#2f3030' : ''; b.style.color = m === met ? '#fff' : ''; });
  if ($('ocScatterSub')) $('ocScatterSub').textContent = `${data.label} · 매장별`;
  if ($('ocScatterTitle')) $('ocScatterTitle').textContent = met === 'hours' ? '매출 대비 근무시간' : met === 'prod' ? '매출 대비 생산성 (목표 곡선)' : '매출 대비 인건비율';
  const note = $('ocScatterNote'), shortOf = s => s;
  let pts, colorOf, datasets, yTitle, tip, noteHtml, xTitleText;
  const xs = rows.map(r => r.sales / 1e8); let px0 = Math.min(...xs), px1 = Math.max(...xs);
  const pad = (px1 - px0) * 0.06 + 0.02; let x0 = px0 - pad, x1 = px1 + pad;
  if (met === 'hours') {
    const ys = rows.map(r => r.mh), mx = ocMean(xs), my = ocMean(ys);
    let sxy = 0, sxx = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
    const sl = sxx ? sxy / sxx : 0, ic = my - sl * mx;
    pts = rows.map(r => { const x = r.sales / 1e8, fy = ic + sl * x; return { x, y: r.mh, code: r.code, name: shortOf(r.name), pct: (r.mh / fy - 1) * 100 }; });
    colorOf = p => p.pct > 8 ? OC_COL.red : p.pct < -8 ? OC_COL.blue : OC_COL.ink;
    datasets = [{ label: '매장', data: pts, pointRadius: 6, pointHoverRadius: 8, pointBackgroundColor: pts.map(colorOf), pointBorderColor: '#fff' },
      { type: 'line', label: `${rows.length}개점 평균 직선 (${won(ic)}h + 매출 1억당 ${won(sl)}h)`, data: [{ x: x0, y: ic + sl * x0 }, { x: x1, y: ic + sl * x1 }], borderColor: OC_COL.orange, borderDash: [6, 4], borderWidth: 1.6, pointRadius: 0 }];
    yTitle = '총 근무시간 (h, 정직원+메이트)';
    tip = c => `${pts[c.dataIndex].name}: ${won(pts[c.dataIndex].y)}h · 같은 매출 평균 대비 ${pts[c.dataIndex].pct >= 0 ? '+' : ''}${pts[c.dataIndex].pct.toFixed(0)}% (클릭 → 매장 피드백)`;
    noteHtml = '직선 = 같은 매출에서 전사 평균 근무시간. <b>직선 아래(파랑)일수록 같은 매출을 적은 시간으로</b> 해내는 매장, 위(빨강)는 평균보다 시간을 많이 쓰는 매장입니다(±8% 기준). 매출이 클수록 근무시간도 늘어 직선이 올라갑니다.';
  } else if (met === 'prod') {
    // 생산성(원/MH) vs 일평균 매출(백만) — 곡선 = labor-calc.js PROD_CURVE(저매출 하한선 포함). 점 색 = 점수 신호등(100/90).
    const prow = rows.filter(r => r.dailyX > 0 && r.prod > 0);
    pts = prow.map(r => { const t = prodTargetAt(r.dailyX), sc = prodScore(r.prod, t); return { x: r.dailyX, y: r.prod, code: r.code, name: shortOf(r.name), target: t, sc }; });
    colorOf = p => p.sc ? (p.sc.level === 'g' ? OC_COL.green : p.sc.level === 'w' ? OC_COL.orange : OC_COL.red) : OC_COL.gray;
    const pxs = pts.map(p => p.x), pmin = Math.min(...pxs), pmax = Math.max(...pxs), ppad = (pmax - pmin) * 0.06 + 0.1; px0 = Math.max(0.5, pmin - ppad); px1 = pmax + ppad;
    const curve = []; for (let i = 0; i <= 48; i++) { const x = px0 + (px1 - px0) * i / 48; curve.push({ x, y: prodTargetAt(x) }); }
    datasets = [{ label: '매장', data: pts, pointRadius: 6, pointHoverRadius: 8, pointBackgroundColor: pts.map(colorOf), pointBorderColor: '#fff' },
      { type: 'line', label: '목표 생산성 곡선 (2차 곡선 + 저매출 하한선)', data: curve, borderColor: OC_COL.blue, borderWidth: 2.4, pointRadius: 0, tension: 0.15 }];
    yTitle = '생산성 (원/MH, 총매출÷총 근무시간)'; xTitleText = `${data.label} 일평균 매출 (백만원)`;
    tip = c => { const p = pts[c.dataIndex]; return `${p.name}: 생산성 ${won(p.y)}원/MH · 목표 ${won(p.target)} · 점수 ${p.sc ? p.sc.shown.toFixed(0) + '%' + (p.sc.surplus > 0.5 ? ` (+${p.sc.surplus.toFixed(0)}% 여유)` : '') : '-'} (클릭 → 매장 피드백)`; };
    noteHtml = '<b>파란 곡선 = 그 매출대에서 달성해야 할 목표 생산성</b>(브랜드 목표 인건비 기준). 점수(= 생산성 ÷ 목표)가 95% 이상이면 초록, 85% 이하면 빨강, 그 사이는 주황입니다. 곡선 아래로 멀수록 점수가 낮습니다. 곡선은 매출이 클수록 완만하게 오르고, 저매출 구간은 인건비율 34%를 넘지 않도록 하한선이 적용됩니다.';
  } else {
    pts = rows.map(r => ({ x: r.sales / 1e8, y: r.ratio, code: r.code, name: shortOf(r.name) }));
    colorOf = p => p.y > LABOR_CAP * 100 ? '#8b1a1a' : p.y > 28 ? OC_COL.red : p.y > 24 ? OC_COL.orange : OC_COL.green;
    const hl = (v, col, lab, dash) => ({ type: 'line', label: lab, data: [{ x: x0, y: v }, { x: x1, y: v }], borderColor: col, borderDash: dash, borderWidth: 1.2, pointRadius: 0 });
    datasets = [{ label: '매장', data: pts, pointRadius: 6, pointHoverRadius: 8, pointBackgroundColor: pts.map(colorOf), pointBorderColor: '#fff' },
      hl(24, OC_COL.green, '24% (목표권)', [5, 4]), hl(28, OC_COL.orange, '28% (관리)', [5, 4]), hl(LABOR_CAP * 100, '#8b1a1a', `${Math.round(LABOR_CAP * 100)}% (상한)`, [2, 3])];
    yTitle = '인건비율 (%)';
    tip = c => `${pts[c.dataIndex].name}: 인건비율 ${pts[c.dataIndex].y.toFixed(1)}% · 매출 ${pts[c.dataIndex].x.toFixed(2)}억 (클릭 → 매장 피드백)`;
    noteHtml = '<b>아래쪽(초록)일수록 효율적</b>입니다. 색 = 인건비율 밴드(24% 이하 초록 · 24~28% 주황 · 28% 초과 빨강 · 상한 38% 초과 진한 빨강). 매출이 낮은 매장은 최소 인원이 고정이라 비율이 높아지기 쉽습니다.';
  }
  if (met === 'prod') { x0 = px0; x1 = px1; }
  if (OC.scatter) OC.scatter.destroy();
  OC.scatter = new Chart($('ocScatter'), {
    type: 'scatter', data: { datasets },
    options: { responsive: true, maintainAspectRatio: false,
      onClick: (_e, els) => { const el = els.find(x => x.datasetIndex === 0); if (!el) return; const code = pts[el.index].code; showView('feedback'); const s = $('fbStore'); if (s) { s.value = code; if (typeof loadFeedback === 'function') loadFeedback(); } },
      onHover: (e, els) => { e.native.target.style.cursor = els.some(x => x.datasetIndex === 0) ? 'pointer' : 'default'; },
      plugins: { legend: { display: true, position: 'bottom', labels: { filter: it => it.datasetIndex > 0, boxWidth: 24 } },
        tooltip: { filter: c => c.datasetIndex === 0, callbacks: { label: tip } } },
      scales: { x: { title: { display: true, text: xTitleText || `${data.label} 외형매출 (억원)` }, min: x0, max: x1 }, y: { title: { display: true, text: yTitle }, ...(met === 'ratio' ? { min: Math.max(0, Math.floor(Math.min(...pts.map(p => p.y), 20) - 2)), max: Math.ceil(Math.max(...pts.map(p => p.y), LABOR_CAP * 100) + 2) } : {}) } } },
    plugins: [ocLabelPlugin(pts, colorOf)] });
  note.innerHTML = `${noteHtml} 점을 누르면 그 매장의 피드백 그래프로 이동합니다.`;
}

// ---------- 매장 피드백: 매장별 그래프 ----------
function ocBadge(v) { const m = { orange: ['#fde9d9', '#b35a10'], blue: ['#dfeefc', '#1f5f9e'], green: ['#e6f5d6', '#2d7a0b'], gray: ['#eee', '#555'] }[v[1]]; return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:700;background:${m[0]};color:${m[1]}">${v[0]}</span>`; }
const ocF1 = v => (v >= 0 ? '+' : '') + v.toFixed(1);


// ---------- 기준 매장표 (2026-10-28): V2.1 표 전 매장 평균 형태 × 매출대별 필요 근무시간(곡선의 직선 근사) ----------
// 형태 = 각 매장 표의 시간대별 인원 ÷ 하루 총 인원합 을 전 매장 평균. 필요 총 MH = prodMHAt(그 요일유형 일평균 매출) — labor-calc.js
function ocRefShape() {
  if (OC.shape) return OC.shape;
  const out = { weekday: {}, weekend: {} };
  for (const dt of ['weekday', 'weekend']) {
    const codes = Object.keys(OT_STD).filter(c => OT_STD[c][dt]); let n = 0;
    for (const c of codes) {
      const hrs = OT_STD[c][dt].stats.hours, tot = hrs.reduce((t, r) => t + r.need, 0); if (!(tot > 0)) continue;
      hrs.forEach(r => { out[dt][r.h] = (out[dt][r.h] || 0) + r.need / tot; }); n++;
    }
    Object.keys(out[dt]).forEach(h => { out[dt][h] /= n || 1; });
  }
  return (OC.shape = out);
}
// 한 매장·월·요일유형의 기준 시간대별 인원(9~21시). 영업일 기록이 없으면 null
function ocRefSeries(code, ym, dt, hrs) {
  const days = (OC.byStore[code] || []).filter(d => d.ym === ym && d.dt === dt); if (!days.length) return null;
  const x = ocMean(days.map(d => d.sales)) / 1e6, mh = prodMHAt(x), sh = ocRefShape()[dt];
  return { x, mh, data: hrs.map(h => (sh[h] || 0) * mh) };
}

// ---------- 피어그룹(같은 매출대 3개점) 비교 ----------
const OC_BANDS = [['오픈 9~11시', [9, 10]], ['런치 11~14시', [11, 12, 13]], ['브레이크 14~17시', [14, 15, 16]], ['디너 17~20시', [17, 18, 19]], ['마감 20~22시', [20, 21]]];
function ocMonthStat(code, ym) {
  const days = (OC.byStore[code] || []).filter(d => d.ym === ym); if (days.length < 5) return null;
  const sales = days.reduce((t, d) => t + d.sales, 0), adjH = typeof otAdjHours === 'function' ? otAdjHours(code, ym, days[days.length - 1].date) : 0;
  const mh = days.reduce((t, d) => t + d.mh, 0) + adjH; // 기준정보 특이값(보정시간) 반영
  const band = OC_BANDS.map(([, hs]) => ocMean(days.map(d => ocMean(hs.map(h => hourIdx(d.byHour, h) || 0)))));
  // 저장된 시간대(예전 업로드는 9~21시) 밖의 근무 = 총 근무시간 − 시간대 합. 8시 출근·22시 이후 마감이 여기에 해당 (새 형식 행은 거의 0)
  const legacy = days.filter(d => d.byHour.length === 13), outside = legacy.length ? ocMean(legacy.map(d => d.mh - d.byHour.reduce((t, v) => t + v, 0))) : null;
  return { outside, nLegacy: legacy.length, n: days.length, sales, mh, x: sales / days.length / 1e6, prod: sales / mh, band, mhDay: mh / days.length };
}
// 반환: { html, top:[{name, diff, eff}], score, target, me } — 효과(%p) = 인원차 × 구간시간 × 영업일 × 실질시급 ÷ 순매출 (+이면 피어보다 많이 쓰는 만큼 줄일 여지)
function ocPeerCompare(code, ym) {
  const me = ocMonthStat(code, ym);
  if (!me) return { html: '<p class="dnote">이 달 실적이 5일 미만이라 피어 비교를 만들 수 없습니다.</p>', top: [] };
  const others = Object.keys(OT_DATA).filter(c => c !== code).map(c => ({ c, st: ocMonthStat(c, ym) })).filter(o => o.st)
    .sort((a, b) => Math.abs(a.st.x - me.x) - Math.abs(b.st.x - me.x)).slice(0, 3);
  if (others.length < 3) return { html: '<p class="dnote">같은 매출대 비교 매장이 부족합니다.</p>', top: [] };
  const eff = OT_DATA[code].eff, net = me.sales / 1.1, pAvg = i => ocMean(others.map(o => o.st.band[i]));
  const rows = OC_BANDS.map(([name, hs], i) => {
    const pr = pAvg(i), diff = me.band[i] - pr;
    return { name, me: me.band[i], pr, diff, eff: diff * hs.length * me.n * eff / net * 100 };
  });
  const prTot = ocMean(others.map(o => o.st.mhDay));
  const target = prodTargetAt(me.x), sc = prodScore(me.prod, target), peerProd = ocMean(others.map(o => o.st.prod));
  const tr = r => {
    const bg = r.eff >= 0.3 ? 'background:#fdecea' : r.eff <= -0.3 ? 'background:#eaf5e0' : '';
    return `<tr style="${bg}"><td>${r.name}</td><td style="text-align:right">${r.me.toFixed(1)}</td><td style="text-align:right">${r.pr.toFixed(1)}</td><td style="text-align:right">${ocF1(r.diff)}</td><td style="text-align:right;font-weight:700">${(r.eff >= 0 ? '+' : '') + r.eff.toFixed(2)}%p</td></tr>`;
  };
  const html = `<div style="font-size:13px;font-weight:700;margin:0 0 4px;color:#4a4f55">피어 비교 — 같은 매출대 3개점(${others.map(o => OT_DATA[o.c].name).join(', ')}) 대비</div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px"><colgroup><col style="width:34%"><col style="width:16%"><col style="width:16%"><col style="width:14%"><col style="width:20%"></colgroup>
    <thead><tr style="color:#6b7078;border-bottom:1px solid #ddd"><th style="text-align:left;font-weight:600">시간대 구간(평균 인원)</th><th style="text-align:right;font-weight:600">우리</th><th style="text-align:right;font-weight:600">피어</th><th style="text-align:right;font-weight:600">차이</th><th style="text-align:right;font-weight:600">인건비율 효과</th></tr></thead><tbody>
    ${rows.map(tr).join('')}
    <tr style="border-top:1px solid #ddd"><td>하루 총 근무시간(h)</td><td style="text-align:right">${me.mhDay.toFixed(1)}</td><td style="text-align:right">${prTot.toFixed(1)}</td><td style="text-align:right">${ocF1(me.mhDay - prTot)}</td><td></td></tr>
    <tr><td>생산성(원/MH)</td><td style="text-align:right">${won(me.prod)}</td><td style="text-align:right">${won(peerProd)}</td><td style="text-align:right">${ocF1((me.prod / peerProd - 1) * 100)}%</td><td></td></tr></tbody></table>
    <p class="dnote" style="margin:6px 0 0">${ym.slice(5)}월 실적 평균(요일 구분 없이). 빨강 = 피어보다 많이 쓰는 구간(줄일 여지, 효과 큰 순으로 확인), 초록 = 피어보다 적게 쓰는 구간. 포지션별 비교는 매장마다 역할명이 달라 구간 인원으로 대체했습니다. 정직원·고정비 구조 차이는 이 표에 포함되지 않습니다.</p>`;
  const top = rows.filter(r => r.eff > 0.3).sort((a, b) => b.eff - a.eff).slice(0, 3).map(r => ({ name: r.name, diff: r.diff, eff: r.eff }));
  return { html, top, score: sc, target, me, outside: me.outside, nLegacy: me.nLegacy };
}

// ---------- 제안 (전사 대시보드 표 마지막 열, 2026-10-30) ----------
// 어느 요일유형(평일/주말) × 시간대 구간(오픈·런치·브레이크·디너·마감)이 문제인지를 월 시간으로 보여준다.
//   월 시간 = (우리 구간 평균 인원 − 비교 기준 평균 인원) × 구간 길이(h) × 그 달 영업일수(그 요일유형)
//   비교 기준 둘: 피어(같은 매출대 3개점, 피어 비교 표와 같은 매장) / 목표(기준 곡선이 요구하는 시간대별 인원). 표시는 피어 대비를 먼저, 부족하면 목표 대비로 채운다.
const OC_SUG_MIN = 10, OC_SUG_BRAND_MIN = 50;          // 월 10h(매장)·50h(브랜드 합) 미만은 제안하지 않음
const OC_BAND_SHORT = ['오픈', '런치', '브레이크', '디너', '마감'];
function ocBandsByDt(days) {
  const out = {};
  for (const dt of ['weekday', 'weekend']) {
    const ds = days.filter(d => d.dt === dt && d.byHour.length);
    out[dt] = ds.length >= 2 ? OC_BANDS.map(([, hs]) => ocMean(ds.map(d => ocMean(hs.map(h => hourIdx(d.byHour, h) || 0))))) : null;
  }
  return out;
}
function ocOpenDayCount(code, ym) {
  const n = { weekday: 0, weekend: 0 };
  for (const x of monthDates(ym, OT_DATA[code])) if (!x.closed) n[(x.hol || x.wd >= 5) ? 'weekend' : 'weekday']++;
  return n;
}
// 한 매장의 (요일유형 × 구간) 셀: { dt, i, peer, tgt, nd } — 피어·목표 대비 월 시간(+이면 우리가 더 씀). 계산 불가면 null
function ocSuggestCells(code, ym, ctx) {
  const days = (OC.byStore[code] || []).filter(d => d.ym === ym); if (days.length < 5) return null;
  const mine = ocBandsByDt(days), nd = ocOpenDayCount(code, ym), me = ctx.stat[code]; if (!me) return null;
  const peers = Object.keys(ctx.stat).filter(c => c !== code && ctx.stat[c]).sort((a, b) => Math.abs(ctx.stat[a].x - me.x) - Math.abs(ctx.stat[b].x - me.x)).slice(0, 3).map(c => ctx.bands[c]);
  const hrs = []; for (let h = 9; h <= 21; h++) hrs.push(h);
  const cells = [];
  for (const dt of ['weekday', 'weekend']) {
    if (!mine[dt]) continue;
    const ref = ocRefSeries(code, ym, dt, hrs), pb = peers.map(p => p[dt]).filter(Boolean);
    OC_BANDS.forEach(([, hs], i) => {
      const len = hs.length * nd[dt];
      cells.push({ dt, i, nd: nd[dt], len,
        tgt: ref ? (mine[dt][i] - ocMean(hs.map(h => ref.data[h - 9]))) * len : null,
        peer: pb.length >= 2 ? (mine[dt][i] - ocMean(pb.map(b => b[i]))) * len : null });
    });
  }
  return cells;
}
const ocSugName = c => `${OC_DT[c.dt]} ${OC_BAND_SHORT[c.i]}`;
function ocSuggestHtml(cells) {
  // 피어 대비(같은 매출대 매장보다 더 쓰는 구간)를 먼저, 2개가 안 되면 목표(곡선) 대비로 채운다 — 목표는 피어보다 엄격해 거의 모든 구간이 걸리기 때문
  const pick = (key, basis, skip) => (cells || []).filter(c => c[key] != null && c[key] >= OC_SUG_MIN && !skip.has(c.dt + c.i))
    .sort((a, b) => b[key] - a[key]).map(c => ({ c, h: c[key], basis }));
  const first = pick('peer', '피어 대비', new Set()).slice(0, 1);
  const items = first.concat(pick('tgt', '목표 대비', new Set(first.map(x => x.c.dt + x.c.i)))).slice(0, 1); // 가장 큰 1가지만
  if (!items.length) return '<span style="color:var(--muted2)">특이 구간 없음</span>';
  return items.map(({ c, h, basis }) => {
    const tip = `${ocSugName(c)} — 월 기준(영업일 ${c.nd}일 × ${c.len / c.nd}시간 구간): 피어 ${c.peer != null ? ocF1(c.peer) + 'h' : '-'} · 목표(곡선) ${c.tgt != null ? ocF1(c.tgt) + 'h' : '-'}`;
    return `<div title="${tip}" style="white-space:nowrap">${ocSugName(c)} <b style="color:var(--crit)">+${Math.round(h).toLocaleString()}h</b> <span style="font-size:11px;color:var(--muted2)">${basis}</span></div>`;
  }).join('');
}
// 브랜드 행: 전 매장 목표(곡선) 대비 월 시간을 셀별로 합산해 큰 순 2개
function ocSuggestBrandHtml(all) {
  const sum = {};
  for (const cells of all) for (const c of cells || []) if (c.tgt != null) { const k = c.dt + c.i; (sum[k] = sum[k] || { c, h: 0 }).h += c.tgt; }
  const items = Object.values(sum).filter(x => x.h >= OC_SUG_BRAND_MIN).sort((a, b) => b.h - a.h).slice(0, 1);
  if (!items.length) return '<span style="color:var(--muted2)">특이 구간 없음</span>';
  return items.map(({ c, h }) => `<div title="${ocSugName(c)} — 전 매장 합계, 목표(곡선) 대비 월 시간" style="white-space:nowrap">${ocSugName(c)} <b style="color:var(--crit)">+${Math.round(h).toLocaleString()}h</b> <span style="font-size:11px;color:var(--muted2)">전사 목표 대비</span></div>`).join('');
}
async function ocFillSuggest(ym, myReq) {
  const box = $('dashTable'); if (!box || !box.querySelector('td.sg')) return;
  const fail = () => box.querySelectorAll('td.sg').forEach(td => { td.textContent = '-'; });
  try { await ocLoad(); } catch (e) { fail(); return; }
  if (typeof dashReqId !== 'undefined' && myReq !== dashReqId) return; // 그 사이 다른 조회로 바뀜
  try {
    const ctx = { stat: {}, bands: {} };
    for (const code of Object.keys(OT_DATA)) {
      const st = ocMonthStat(code, ym); if (!st) continue;
      ctx.stat[code] = st; ctx.bands[code] = ocBandsByDt((OC.byStore[code] || []).filter(d => d.ym === ym));
    }
    const all = [];
    box.querySelectorAll('td.sg').forEach(td => {
      const code = td.dataset.code; if (code === '*') return;
      const cells = ocSuggestCells(code, ym, ctx); all.push(cells);
      td.innerHTML = cells ? ocSuggestHtml(cells) : '<span style="color:var(--muted2)">-</span>';
    });
    const b = box.querySelector('td.sg[data-code="*"]'); if (b) b.innerHTML = ocSuggestBrandHtml(all);
  } catch (e) { fail(); }
}
window.ocFillSuggest = ocFillSuggest;

function ocSentences(dg, ym, extra) {
  const out = [];
  for (const dt of ['weekday', 'weekend']) {
    const o = dg.dt[dt];
    if (o.front == null) { out.push(`<b>${OC_DT[dt]}</b>: 표 ${o.plan.toFixed(0)}h (달성선 계산 불가 — 객수 데이터 부족)`); continue; }
    out.push(`<b>${OC_DT[dt]}</b>: 표 ${o.plan.toFixed(0)}h · 달성선 ${o.front.toFixed(0)}h${o.act != null ? ` · ${ym.slice(5)}월 실제 ${o.act.toFixed(0)}h` : ''} — 표가 달성선보다 ${ocF1(o.diff)}h(${ocF1(o.pct)}%)${o.act != null ? `, 실제는 표보다 ${ocF1(o.aDiff)}h(${ocF1(o.aPct)}%)` : ''}`);
  }
  const w = dg.dt.weekday;
  out.push(`평일 상시 인원(영업시간 하위 25% 시간대) ${w.baseN.toFixed(1)}명, 피크 ${w.peakN.toFixed(1)}명(${w.peakH}시)`);
  if (extra && extra.outside != null && extra.outside >= 0.5) out.push(`<b>9시 이전·21시 이후 근무</b>: ${ym.slice(5)}월 하루 평균 ${extra.outside.toFixed(1)}h (${extra.nLegacy}일 기록) — 시간대 그래프 범위 밖이라 그래프에는 빠져 있습니다. 출퇴근 기록부를 다시 업로드하면 8시부터 시간대별로 보이고, 8시 출근 매장은 9시 이후 출근으로 조정 피드백 대상입니다.`);
  if (extra && extra.score) {
    const sc = extra.score, col = sc.level === 'g' ? '#2d7a0b' : sc.level === 'w' ? '#b35a10' : '#b32d2d';
    out.unshift(`<b>생산성 점수</b>: ${ym.slice(5)}월 ${won(extra.me.prod)}원/MH ÷ 곡선 목표 ${won(extra.target)}원/MH(일평균 매출 ${extra.me.x.toFixed(1)}백만) = <b style="color:${col}">${sc.shown.toFixed(0)}%</b>${sc.surplus > 0.5 ? ` (+${sc.surplus.toFixed(0)}% 여유)` : ''}`);
  }
  return out;
}
function ocQuestions(dg, peer) {
  const qs = [], w = dg.dt.weekday, e = dg.dt.weekend;
  if (peer && peer.top && peer.top.length) qs.push(`같은 매출대 매장보다 ${peer.top.map(x => `${x.name} ${ocF1(x.diff)}명(인건비율 +${x.eff.toFixed(1)}%p)`).join(', ')} — 이 시간대에 더 필요한 이유(구조·동선·장비)가 있나요?`);
  if ([w, e].some(x => x.pct != null && x.pct > 10)) qs.push([w, e].some(x => x.aPct != null && x.aPct < 0) ? '실제로는 표대로(또는 더 적게) 운영하셨는데, 표를 달성선 수준으로 줄여도 운영에 문제가 없을까요?' : '표가 달성선보다 큰 부분(시간대·포지션)을 줄일 수 있는지 같이 보면 좋겠습니다.');
  if ([w, e].some(x => x.aPct != null && x.aPct > 10)) qs.push('실제로는 표보다 많이 일하는 시간대가 있는데(결원·교육·행사·연장 등) 표에 반영해야 할 사유가 있나요?');
  if (!qs.length) qs.push('표와 실제가 비슷한 범위입니다. 최소 인원·피크 구간 설계 근거를 한 번 공유해 주세요.');
  return qs;
}

async function ocRenderFeedback(code, ym) {
  const box = $('fbGraphs'); if (!box) return;
  const myKey = code + '|' + ym; OC.fbKey = myKey;
  ocDestroyFb();
  if (typeof Chart === 'undefined') { box.innerHTML = ''; return; }
  box.innerHTML = '<p class="dnote">표 점검 그래프 계산 중…</p>';
  try { await ocLoad(); } catch (e) { box.innerHTML = `<p class="dnote">그래프 데이터를 불러오지 못했습니다: ${e.message || e}</p>`; return; }
  if (OC.fbKey !== myKey) return; // 그 사이 다른 매장·월로 바뀜
  const dg = ocDiag(code, ym), name = OT_DATA[code] ? OT_DATA[code].name : code;
  const peer = dg ? ocPeerCompare(code, ym) : null;
  if (!dg) { box.innerHTML = `<div class="card" style="margin-bottom:14px"><h3 style="margin:0 0 6px">${name} — 표 점검 그래프</h3><p class="dnote">이 매장은 표준 사용 계획표가 등록되지 않아 그래프를 그릴 수 없습니다.</p></div>`; return; }
  ocFontInit();
  // 판정 배지와 확인 질문은 기획자 계정에만 — 매장 관리자(공용 계정)에게는 숫자 그래프만 보여준다
  const planner = typeof currentRole === 'undefined' || currentRole === 'planner';
  box.innerHTML = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:12px"><h3 style="margin:0">${name} — 표 점검 그래프</h3><span class="dnote" style="margin:0">표 = 현재 표준 사용 계획표(V2.1) · 실제 = ${ym.slice(0, 4)}년 ${+ym.slice(5)}월 평균 · 기준(곡선) = 이 매출대에서 브랜드 목표 곡선이 요구하는 시간대별 인원 · 달성선 = 8월~ 일별 실적에서 잘 운영한 날 수준</span><span style="margin-left:auto">${planner ? ocBadge(dg.verdict) : ''}</span></div>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:10px"><div style="position:relative;height:260px"><canvas id="ocHrWd"></canvas></div><div style="position:relative;height:260px"><canvas id="ocHrWe"></canvas></div></div>
    <div style="display:grid;grid-template-columns:1.15fr 1fr 1fr;gap:12px;margin-top:10px"><div style="position:relative;height:270px"><canvas id="ocBars"></canvas></div><div id="ocPeer" style="grid-column:span 2;min-height:270px;padding:2px 4px"></div></div>
    <ul style="margin:10px 0 6px;padding-left:20px;font-size:13px;line-height:1.7">${ocSentences(dg, ym, peer).map(s => `<li>${s}</li>`).join('')}</ul>
    ${planner ? `<div style="background:#f3fbe7;border-left:4px solid #82dc28;padding:8px 14px;font-size:13px"><b>확인 사항</b><ul style="margin:4px 0 0;padding-left:18px">${ocQuestions(dg, peer).map(q => `<li>${q}</li>`).join('')}</ul></div>` : ''}
    <p class="dnote" style="margin-top:8px">주황 음영 = 표가 실제보다 많이 배치한 시간 · 파랑 음영 = 실제가 표보다 많이 일한 시간. 파란 점선(기준) = 전 매장 V2.1 표의 평균 시간대 형태 × 이 매출대에서 곡선이 요구하는 하루 근무시간. 피어 비교 표의 빨강 = 같은 매출대 매장보다 시간을 더 쓰는 구간. 달성선은 정답이 아니라 "실제로 해낸 수준"이며 인원이 부족했던 날도 섞일 수 있습니다 — 확정 판단이 아닌 <b>논의용</b> 자료입니다.</p></div>`;
  const hrs = []; for (let h = 8; h <= 21; h++) hrs.push(h);
  const mk = (id, cfg) => { const c = new Chart($(id), cfg); OC.fbCharts.push(c); return c; };
  const base = { responsive: true, maintainAspectRatio: false };
  for (const [id, dt] of [['ocHrWd', 'weekday'], ['ocHrWe', 'weekend']]) {
    const hm = ocHourMap(ocPlan(code, dt)), plan = hrs.map(h => hm[h] || 0);
    const days = (OC.byStore[code] || []).filter(d => d.ym === ym && d.dt === dt);
    const act = days.length ? hrs.map(h => { const v = days.map(d => hourIdx(d.byHour, h)).filter(x => x != null); return v.length ? ocMean(v) : null; }) : null;
    const ds = [{ label: '표(계획)', data: plan, stepped: 'middle', borderColor: OC_COL.ink, borderWidth: 2, pointRadius: 0, fill: act ? { target: 1, above: 'rgba(217,130,43,.22)', below: 'rgba(55,138,221,.22)' } : false }];
    if (act) ds.push({ label: `${+ym.slice(5)}월 실제 평균`, data: act, borderColor: OC_COL.green, backgroundColor: OC_COL.green, borderWidth: 2, pointRadius: 3, tension: .15, fill: false });
    const rs = ocRefSeries(code, ym, dt, hrs);
    if (rs) ds.push({ label: `기준(곡선, 일매출 ${rs.x.toFixed(1)}백만 → ${rs.mh.toFixed(0)}h)`, data: rs.data, borderColor: OC_COL.blue, borderDash: [6, 4], borderWidth: 2.5, pointRadius: 0, tension: .2, fill: false });
    mk(id, { type: 'line', data: { labels: hrs.map(h => h + '시'), datasets: ds }, options: { ...base, plugins: { title: { display: true, text: `${OC_DT[dt]} — 시간대별 근무 인원`, align: 'start' }, legend: { position: 'bottom', labels: { boxWidth: 14 } } }, scales: { y: { beginAtZero: true, title: { display: true, text: '인원(명)' } } } } });
  }
  const g = dt => dg.dt[dt];
  mk('ocBars', { type: 'bar', data: { labels: ['평일', '주말'], datasets: [
    { label: '표(계획)', data: [g('weekday').plan, g('weekend').plan], backgroundColor: OC_COL.ink },
    { label: '달성선(잘 운영한 날)', data: [g('weekday').front, g('weekend').front], backgroundColor: OC_COL.orange },
    { label: `${+ym.slice(5)}월 실제 평균`, data: [g('weekday').act, g('weekend').act], backgroundColor: OC_COL.green }] },
    options: { ...base, plugins: { title: { display: true, text: '하루 근무시간(h): 표 vs 달성선 vs 실제', align: 'start' }, legend: { position: 'bottom', labels: { boxWidth: 12 } }, ocValueLabels: { on: true } }, scales: { y: { beginAtZero: true, grace: '12%' } } }, plugins: [ocValueLabels] });
  const pp = $('ocPeer'); if (pp && peer) pp.innerHTML = peer.html;
}
window.ocRenderFeedback = ocRenderFeedback; window.ocRenderScatter = ocRenderScatter; window.ocSetMetric = ocSetMetric;
