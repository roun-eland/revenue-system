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
function ocMetric() { if (OC.met) return OC.met; try { return localStorage.getItem('oc_met') === 'ratio' ? 'ratio' : 'hours'; } catch (e) { return 'hours'; } }
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
  [['ocMetHrs', 'hours'], ['ocMetRatio', 'ratio']].forEach(([id, m]) => { const b = $(id); if (!b) return; b.style.background = m === met ? '#2f3030' : ''; b.style.color = m === met ? '#fff' : ''; });
  if ($('ocScatterSub')) $('ocScatterSub').textContent = `${data.label} · 매장별`;
  if ($('ocScatterTitle')) $('ocScatterTitle').textContent = met === 'hours' ? '매출 대비 근무시간' : '매출 대비 인건비율';
  const note = $('ocScatterNote'), shortOf = s => s;
  let pts, colorOf, datasets, yTitle, tip, noteHtml;
  const xs = rows.map(r => r.sales / 1e8), px0 = Math.min(...xs), px1 = Math.max(...xs), pad = (px1 - px0) * 0.06 + 0.02, x0 = px0 - pad, x1 = px1 + pad;
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
  if (OC.scatter) OC.scatter.destroy();
  OC.scatter = new Chart($('ocScatter'), {
    type: 'scatter', data: { datasets },
    options: { responsive: true, maintainAspectRatio: false,
      onClick: (_e, els) => { const el = els.find(x => x.datasetIndex === 0); if (!el) return; const code = pts[el.index].code; showView('feedback'); const s = $('fbStore'); if (s) { s.value = code; if (typeof loadFeedback === 'function') loadFeedback(); } },
      onHover: (e, els) => { e.native.target.style.cursor = els.some(x => x.datasetIndex === 0) ? 'pointer' : 'default'; },
      plugins: { legend: { display: true, position: 'bottom', labels: { filter: it => it.datasetIndex > 0, boxWidth: 24 } },
        tooltip: { filter: c => c.datasetIndex === 0, callbacks: { label: tip } } },
      scales: { x: { title: { display: true, text: `${data.label} 외형매출 (억원)` }, min: x0, max: x1 }, y: { title: { display: true, text: yTitle }, ...(met === 'ratio' ? { min: Math.max(0, Math.floor(Math.min(...pts.map(p => p.y), 20) - 2)), max: Math.ceil(Math.max(...pts.map(p => p.y), LABOR_CAP * 100) + 2) } : {}) } } },
    plugins: [ocLabelPlugin(pts, colorOf)] });
  note.innerHTML = `${noteHtml} 점을 누르면 그 매장의 피드백 그래프로 이동합니다.`;
}

// ---------- 매장 피드백: 매장별 그래프 ----------
function ocBadge(v) { const m = { orange: ['#fde9d9', '#b35a10'], blue: ['#dfeefc', '#1f5f9e'], green: ['#e6f5d6', '#2d7a0b'], gray: ['#eee', '#555'] }[v[1]]; return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:700;background:${m[0]};color:${m[1]}">${v[0]}</span>`; }
const ocF1 = v => (v >= 0 ? '+' : '') + v.toFixed(1);

function ocSentences(dg, ym) {
  const out = [];
  for (const dt of ['weekday', 'weekend']) {
    const o = dg.dt[dt];
    if (o.front == null) { out.push(`<b>${OC_DT[dt]}</b>: 표 ${o.plan.toFixed(0)}h (달성선 계산 불가 — 객수 데이터 부족)`); continue; }
    out.push(`<b>${OC_DT[dt]}</b>: 표 ${o.plan.toFixed(0)}h · 달성선 ${o.front.toFixed(0)}h${o.act != null ? ` · ${ym.slice(5)}월 실제 ${o.act.toFixed(0)}h` : ''} — 표가 달성선보다 ${ocF1(o.diff)}h(${ocF1(o.pct)}%)${o.act != null ? `, 실제는 표보다 ${ocF1(o.aDiff)}h(${ocF1(o.aPct)}%)` : ''}`);
  }
  const w = dg.dt.weekday;
  out.push(`평일 상시 인원(영업시간 하위 25% 시간대) ${w.baseN.toFixed(1)}명, 피크 ${w.peakN.toFixed(1)}명(${w.peakH}시)`);
  return out;
}
function ocQuestions(dg) {
  const qs = [], w = dg.dt.weekday, e = dg.dt.weekend;
  for (const dt of ['weekday', 'weekend']) {
    const o = dg.dt[dt], top = o.dev.slice().sort((a, b) => b.dev - a.dev).slice(0, 2).filter(x => x.dev > 1);
    if (top.length && (dt === 'weekday' || (o.pct != null && o.pct > 10))) qs.push(`${OC_DT[dt]} ${top.map(x => `${x.cat} +${x.dev.toFixed(0)}h`).join(', ')} — 같은 매출의 다른 매장보다 시간이 많은데 이유(구조·동선·장비)가 있나요?`);
  }
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
  if (!dg) { box.innerHTML = `<div class="card" style="margin-bottom:14px"><h3 style="margin:0 0 6px">${name} — 표 점검 그래프</h3><p class="dnote">이 매장은 표준 사용 계획표가 등록되지 않아 그래프를 그릴 수 없습니다.</p></div>`; return; }
  ocFontInit();
  // 판정 배지와 확인 질문은 기획자 계정에만 — 매장 관리자(공용 계정)에게는 숫자 그래프만 보여준다
  const planner = typeof currentRole === 'undefined' || currentRole === 'planner';
  box.innerHTML = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:12px"><h3 style="margin:0">${name} — 표 점검 그래프</h3><span class="dnote" style="margin:0">표 = 선임점장 표준 사용 계획표 · 실제 = ${ym.slice(0, 4)}년 ${+ym.slice(5)}월 평균 · 달성선 = 8월~ 일별 실적에서 잘 운영한 날 수준</span><span style="margin-left:auto">${planner ? ocBadge(dg.verdict) : ''}</span></div>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:10px"><div style="position:relative;height:260px"><canvas id="ocHrWd"></canvas></div><div style="position:relative;height:260px"><canvas id="ocHrWe"></canvas></div></div>
    <div style="display:grid;grid-template-columns:1.15fr 1fr 1fr;gap:12px;margin-top:10px"><div style="position:relative;height:270px"><canvas id="ocBars"></canvas></div><div style="position:relative;height:270px"><canvas id="ocPosWd"></canvas></div><div style="position:relative;height:270px"><canvas id="ocPosWe"></canvas></div></div>
    <ul style="margin:10px 0 6px;padding-left:20px;font-size:13px;line-height:1.7">${ocSentences(dg, ym).map(s => `<li>${s}</li>`).join('')}</ul>
    ${planner ? `<div style="background:#f3fbe7;border-left:4px solid #82dc28;padding:8px 14px;font-size:13px"><b>확인 사항</b><ul style="margin:4px 0 0;padding-left:18px">${ocQuestions(dg).map(q => `<li>${q}</li>`).join('')}</ul></div>` : ''}
    <p class="dnote" style="margin-top:8px">주황 음영 = 표가 실제보다 많이 배치한 시간 · 파랑 음영 = 실제가 표보다 많이 일한 시간. 포지션 막대 = 우리 표 시간 − (17개점 중앙값 비율 × 우리 일매출), 빨강 = 같은 매출 평균 매장보다 시간을 더 씀. 달성선은 정답이 아니라 "실제로 해낸 수준"이며 인원이 부족했던 날도 섞일 수 있습니다 — 확정 판단이 아닌 <b>논의용</b> 자료입니다.</p></div>`;
  const hrs = []; for (let h = 9; h <= 21; h++) hrs.push(h);
  const mk = (id, cfg) => { const c = new Chart($(id), cfg); OC.fbCharts.push(c); return c; };
  const base = { responsive: true, maintainAspectRatio: false };
  for (const [id, dt] of [['ocHrWd', 'weekday'], ['ocHrWe', 'weekend']]) {
    const hm = ocHourMap(ocPlan(code, dt)), plan = hrs.map(h => hm[h] || 0);
    const days = (OC.byStore[code] || []).filter(d => d.ym === ym && d.dt === dt);
    const act = days.length ? hrs.map((_, i) => ocMean(days.map(d => d.byHour[i] || 0))) : null;
    const ds = [{ label: '표(계획)', data: plan, stepped: 'middle', borderColor: OC_COL.ink, borderWidth: 2, pointRadius: 0, fill: act ? { target: 1, above: 'rgba(217,130,43,.22)', below: 'rgba(55,138,221,.22)' } : false }];
    if (act) ds.push({ label: `${+ym.slice(5)}월 실제 평균`, data: act, borderColor: OC_COL.green, backgroundColor: OC_COL.green, borderWidth: 2, pointRadius: 3, tension: .15, fill: false });
    mk(id, { type: 'line', data: { labels: hrs.map(h => h + '시'), datasets: ds }, options: { ...base, plugins: { title: { display: true, text: `${OC_DT[dt]} — 시간대별 근무 인원`, align: 'start' }, legend: { position: 'bottom', labels: { boxWidth: 14 } } }, scales: { y: { beginAtZero: true, title: { display: true, text: '인원(명)' } } } } });
  }
  const g = dt => dg.dt[dt];
  mk('ocBars', { type: 'bar', data: { labels: ['평일', '주말'], datasets: [
    { label: '표(계획)', data: [g('weekday').plan, g('weekend').plan], backgroundColor: OC_COL.ink },
    { label: '달성선(잘 운영한 날)', data: [g('weekday').front, g('weekend').front], backgroundColor: OC_COL.orange },
    { label: `${+ym.slice(5)}월 실제 평균`, data: [g('weekday').act, g('weekend').act], backgroundColor: OC_COL.green }] },
    options: { ...base, plugins: { title: { display: true, text: '하루 근무시간(h): 표 vs 달성선 vs 실제', align: 'start' }, legend: { position: 'bottom', labels: { boxWidth: 12 } }, ocValueLabels: { on: true } }, scales: { y: { beginAtZero: true, grace: '12%' } } }, plugins: [ocValueLabels] });
  for (const [id, dt] of [['ocPosWd', 'weekday'], ['ocPosWe', 'weekend']]) {
    const dev = g(dt).dev;
    mk(id, { type: 'bar', data: { labels: dev.map(d => d.cat), datasets: [{ data: dev.map(d => d.dev), backgroundColor: dev.map(d => d.dev > 1 ? OC_COL.red : d.dev < -1 ? OC_COL.blue : OC_COL.gray) }] },
      options: { ...base, indexAxis: 'y', plugins: { title: { display: true, text: `${OC_DT[dt]} 포지션별: 같은 매출 평균 매장 대비(h)`, align: 'start' }, legend: { display: false }, ocValueLabels: { on: true } }, scales: { x: { grace: '25%' } } }, plugins: [ocValueLabels] });
  }
}
window.ocRenderFeedback = ocRenderFeedback; window.ocRenderScatter = ocRenderScatter; window.ocSetMetric = ocSetMetric;
