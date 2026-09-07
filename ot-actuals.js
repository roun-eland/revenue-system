// 로운 생산성 — M2: 매장 피드백(S3) + 실적 입력(S4)
// ot.js 뒤에 로드되어 그 전역(엔진 함수·상수·sb)을 그대로 사용한다.
// 피드백 원칙(PRD §5.7): 필요 MH는 "실적 매출" 기준으로 재계산 — 매출 미달을 인력 과잉으로 오판하지 않는다.

const NOTE_TAGS = ['휴점', '공휴일', '우천', '행사', '결원', '교육', '기타'];
// 근태·급여 업로드용: 기록부의 매장명 → 코드 (동부산은 세팅 대상 외라 제외)
const STORE_NAME_MAP = [['신촌','RU019'],['청량리','RU025'],['평촌','RU029'],['수원터미널','RU030'],
  ['중앙로역','RU031'],['강서','RU032'],['일산','RU033'],['송파','RU034'],['순천','RU035'],
  ['괴정','RU037'],['야탑','RU038'],['광주역','RU039'],['부산대','RU041'],['동탄','RU042'],
  ['의정부','RU043'],['해운대','RU044'],['광명','RU045']];
const FT_ROLE_SET = new Set(['점장','선임점장','부점장','매니저','캡틴','헤드','HIT','ST','TM','GM']);

// 실적 매출 기준 필요 MH (일 단위, 12개 영업시간대 — 8월 분석과 동일 산식)
function needMHof(s, daySales, dowKey) {
  const pct = pctFor(s, dowKey);
  let t = 0;
  for (let i = 0; i < 12; i++) t += Math.max(MINP, Math.round(daySales * pct[i] / TARGET * 2) / 2);
  return t;
}
// 시간대별 필요 인원 (히트맵용, 준비 09시 포함 13칸)
function needByHour(s, daySales, dowKey) {
  const pct = pctFor(s, dowKey);
  return [PREP].concat(pct.map(p => Math.max(MINP, Math.round(daySales * p / TARGET * 2) / 2)));
}

// ---------- S3 매장 피드백 ----------
function buildFbControls() {
  const st = $('fbStore'), mo = $('fbMonth');
  if (!st || st.options.length) return;
  for (const [code, s] of Object.entries(OT_DATA)) {
    const o = document.createElement('option'); o.value = code; o.textContent = '로운 ' + s.name + '점'; st.appendChild(o);
  }
  for (let y = 2026, m = 8;;) {
    const v = `${y}-${String(m).padStart(2, '0')}`;
    const o = document.createElement('option'); o.value = v; o.textContent = `${y}년 ${m}월`; mo.appendChild(o);
    m++; if (m > 12) { m = 1; y++; } if (y === 2028) break;
  }
  st.value = 'RU019'; mo.value = '2026-08';
  st.onchange = loadFeedback; mo.onchange = loadFeedback;
}

async function loadFeedback() {
  buildFbControls();
  const code = $('fbStore').value, ym = $('fbMonth').value;
  const s = OT_DATA[code];
  const box = $('fbBody');
  box.innerHTML = '<p class="dnote">실적 불러오는 중…</p>';

  const from = ym + '-01', to = ym + '-31';
  const [sales, labor, monthly, plans, notes] = await Promise.all([
    sb.from('ot_sales_daily').select('*').eq('store_code', code).gte('sales_date', from).lte('sales_date', to).order('sales_date'),
    sb.from('ot_labor_daily').select('*').eq('store_code', code).gte('work_date', from).lte('work_date', to),
    sb.from('ot_labor_monthly').select('*').eq('store_code', code).eq('ym', ym).maybeSingle(),
    sb.from('ot_plan_runs').select('*').eq('store_code', code).eq('ym', ym).eq('status', 'confirmed').maybeSingle(),
    sb.from('ot_day_notes').select('*').eq('store_code', code).gte('note_date', from).lte('note_date', to),
  ]);
  if (sales.error) { box.innerHTML = `<p class="dnote">불러오기 실패: ${sales.error.message}</p>`; return; }
  if (!sales.data || !sales.data.length) {
    box.innerHTML = `<p class="dnote">${ym} 실적이 없습니다 — [실적 입력] 탭에서 일별매출을 먼저 올려주세요.</p>`;
    return;
  }

  const laborByDate = {}; (labor.data || []).forEach(r => { laborByDate[r.work_date] = r; });
  const notesByDate = {}; (notes.data || []).forEach(n => { (notesByDate[n.note_date] = notesByDate[n.note_date] || []).push(n); });
  const dowKeyOf = d => String((new Date(d + 'T00:00:00').getDay() + 6) % 7);

  // ---- 일별 계산 ----
  const days = sales.data.map(r => {
    const dk = dowKeyOf(r.sales_date);
    const need = needMHof(s, Number(r.total), dk);
    const ld = laborByDate[r.sales_date];
    const used = ld ? (Number(ld.mate_mh) || 0) + (Number(ld.ft_mh) || 0) : null;
    return { date: r.sales_date, d: +r.sales_date.slice(8), dk, sales: Number(r.total), guests: r.guests,
             need, used, over: used != null ? used - need : null,
             prod: used ? Number(r.total) / used : null, byHour: ld ? ld.by_hour : null };
  });
  const actSales = days.reduce((t, x) => t + x.sales, 0);
  const actMH = days.reduce((t, x) => t + (x.used || 0), 0);
  const needMH = days.reduce((t, x) => t + x.need, 0);
  const over = actMH - needMH;
  const overCost = over * s.eff;
  const prod = actMH ? actSales / actMH : 0;

  // ---- 계획(목표) — 확정 계획 있으면 그 값, 없으면 기본값(8월 매출·현 구성) = 임시 기준 ----
  const p = plans.data;
  const planM = p ? Number(p.forecast_sales) : s.augM;
  const nfull = p?.staffing_snapshot?.nfull ?? s.nfull;
  const fullpay0 = p?.staffing_snapshot?.fullpay ?? s.fullpay;
  const plan = computeMonthPlan(code, ym, planM, nfull, fullpay0);
  const planRatio = p?.output?.ratio ?? plan.ratio;
  const achieve = actSales / planM * 100;

  // ---- 실적 인건비율 (월 인건비 실적이 있을 때) ----
  let actRatio = null, ratioNote = '급여 실적 미입력';
  if (monthly.data && monthly.data.mate_pay != null) {
    const m = monthly.data;
    const cost = Number(m.mate_pay) + Number(m.ft_pay || fullpay0) + nfull * 100000 + actSales / 1.1 * 0.006;
    actRatio = cost / (actSales / 1.1) * 100;
    ratioNote = `계획 ${planRatio.toFixed(1)}% 대비 ${(actRatio - planRatio) >= 0 ? '+' : ''}${(actRatio - planRatio).toFixed(1)}%p`;
  }

  // ---- 요일 패턴 (과잉 평균) ----
  const dowAgg = Array.from({ length: 7 }, () => ({ n: 0, over: 0 }));
  days.forEach(x => { if (x.over != null) { dowAgg[+x.dk].n++; dowAgg[+x.dk].over += x.over; } });
  const worstDows = dowAgg.map((a, i) => ({ i, avg: a.n ? a.over / a.n : 0 }))
    .filter(x => x.avg > 3).sort((a, b) => b.avg - a.avg).slice(0, 3);

  // ---- 렌더 ----
  const kb = (v, band) => `<span class="band ${band}">${v}</span>`;
  let html = `<div class="kpis">
    <div><div class="k">매출 달성률</div><div class="v">${achieve.toFixed(0)}%</div><div class="s">실적 ${(actSales/1e8).toFixed(2)}억 / 계획 ${(planM/1e8).toFixed(2)}억 (${p ? '확정 계획' : '기본값'})</div></div>
    <div><div class="k">인건비율 (실적)</div><div class="v">${actRatio != null ? actRatio.toFixed(1) + '%' : '—'}</div><div class="s">${ratioNote}</div></div>
    <div><div class="k">생산성 (실적)</div><div class="v">${won(prod)} <span style="font-size:14px;font-weight:700;color:var(--good)">(${(prod/TARGET*100).toFixed(0)}%)</span></div><div class="s">원/MH · 목표 72,000</div></div>
    <div><div class="k">과잉 투입</div><div class="v" style="color:${over > 0 ? 'var(--crit)' : 'var(--good)'}">${over > 0 ? '+' : ''}${won(over)} MH</div><div class="s">실투입 ${won(actMH)} − 필요 ${won(needMH)} (실적 매출 기준) ≈ ${over > 0 ? won(overCost/10000) + '만원' : '여유'}</div></div>
  </div>`;

  if (worstDows.length)
    html += `<p class="dnote" style="margin:0 0 10px"><b style="color:var(--ink)">요일 패턴:</b> ${worstDows.map(w => `${WD[w.i]}요일 평균 +${w.avg.toFixed(0)}MH`).join(' · ')} 과잉 — 해당 요일 시프트 축소 검토 대상입니다.</p>`;

  // 문제일 상위 5 + 태깅
  const worst = days.filter(x => x.over != null).sort((a, b) => b.over - a.over).slice(0, 5).filter(x => x.over > 3);
  if (worst.length) {
    html += `<div class="card" style="margin-bottom:14px"><h3 style="margin:0 0 8px">과잉 상위 일자 — 원인을 태그로 남겨주세요</h3>
      <div class="tblwrap"><table><colgroup><col style="width:110px"><col style="width:85px"><col style="width:75px"><col style="width:75px"><col style="width:85px"><col style="width:95px"><col></colgroup>
      <thead><tr><th>일자</th><th>매출(만)</th><th>투입</th><th>필요</th><th>과잉</th><th>태그</th><th>메모</th></tr></thead><tbody>`;
    for (const x of worst) {
      const exist = (notesByDate[x.date] || []).map(n => `${n.tag}${n.memo ? '·' + n.memo : ''}`).join(', ');
      html += `<tr><td>${x.d}일(${WD[+x.dk]})</td><td>${won(x.sales/10000)}</td><td>${x.used.toFixed(0)}</td><td>${x.need.toFixed(0)}</td>
        <td style="color:var(--crit)"><b>+${x.over.toFixed(0)}</b></td>
        <td><select class="fb-tag" data-date="${x.date}" style="height:30px;padding:0 6px;font-size:12px"><option value="">선택</option>${NOTE_TAGS.map(t => `<option>${t}</option>`).join('')}</select></td>
        <td><input class="fb-memo" data-date="${x.date}" placeholder="${exist || '메모(선택)'}" style="height:30px;font-size:12px;padding:0 8px;width:100%"></td></tr>`;
    }
    html += `</tbody></table></div>
      <div class="plan-actions" style="margin:10px 0 0"><button id="fbSaveNotes" class="btn btn-sm" type="button">태그 저장</button><span class="plan-msg" id="fbNoteMsg"></span></div></div>`;
  }

  // 일별 캘린더 표
  html += `<div class="card" style="margin-bottom:14px"><h3 style="margin:0 0 8px">일별 매출·투입 vs 필요</h3>
    <div class="tblwrap"><table><colgroup><col style="width:95px"><col style="width:95px"><col style="width:75px"><col style="width:75px"><col style="width:85px"><col style="width:95px"><col></colgroup>
    <thead><tr><th>일자</th><th>매출(만)</th><th>투입 MH</th><th>필요 MH</th><th>Δ(과잉)</th><th>생산성</th><th class="barcell">투입/필요</th></tr></thead><tbody>`;
  const maxUsed = Math.max(...days.map(x => x.used || 0), 1);
  for (const x of days) {
    const oc = x.over == null ? '' : x.over > 5 ? 'color:var(--crit);font-weight:700' : x.over < -3 ? 'color:var(--good)' : '';
    const tags = (notesByDate[x.date] || []).map(n => n.tag).join(',');
    html += `<tr><td>${x.d}일(${WD[+x.dk]})${tags ? ` <span class="band w" style="font-size:10px">${tags}</span>` : ''}</td>
      <td>${won(x.sales/10000)}</td><td>${x.used != null ? x.used.toFixed(0) : '—'}</td><td>${x.need.toFixed(0)}</td>
      <td style="${oc}">${x.over != null ? (x.over > 0 ? '+' : '') + x.over.toFixed(0) : '—'}</td>
      <td>${x.prod ? won(x.prod) : '—'}</td>
      <td class="barcell"><div class="bar"><span class="f" style="width:${(x.need/maxUsed*100).toFixed(0)}%"></span><span class="m" style="width:${Math.max(0,((x.used||0)-x.need)/maxUsed*100).toFixed(0)}%;background:var(--crit)"></span></div></td></tr>`;
  }
  html += `</tbody></table></div><p class="dnote">바 = 필요(진회색) + 초과분(빨강). 필요 MH는 그날 실적 매출을 시간대 분포로 나눠 목표 생산성(72,000원/MH)으로 환산한 값(최소 2명 제약 포함).</p></div>`;

  // 요일×시간대 과잉 히트맵
  const hourAgg = Array.from({ length: 7 }, () => ({ n: 0, used: Array(13).fill(0), need: Array(13).fill(0) }));
  days.forEach(x => {
    if (!x.byHour) return;
    const a = hourAgg[+x.dk]; a.n++;
    const nb = needByHour(s, x.sales, x.dk);
    for (let i = 0; i < 13; i++) { a.used[i] += Number(x.byHour[i]) || 0; a.need[i] += nb[i]; }
  });
  let hh = '<tr><th>시간</th>' + WD.map(w => `<th>${w}</th>`).join('') + '</tr>';
  let hb = '';
  for (let i = 0; i < 13; i++) {
    hb += `<tr><td class="hr">${9 + i}시</td>`;
    for (let d = 0; d < 7; d++) {
      const a = hourAgg[d];
      const dv = a.n ? (a.used[i] - a.need[i]) / a.n : 0;
      const bg = dv > 0.5 ? `background:color-mix(in srgb,var(--crit) ${Math.min(55, Math.round(dv * 14))}%,transparent)` : dv < -0.5 ? 'background:#f3fbe7' : '';
      hb += `<td style="${bg}">${a.n ? (dv > 0 ? '+' : '') + dv.toFixed(1) : '·'}</td>`;
    }
    hb += '</tr>';
  }
  html += `<div class="card"><h3 style="margin:0 0 8px">요일 × 시간대 과잉 투입 (평균, 명)</h3>
    <div class="tblwrap"><table class="dtable"><thead>${hh}</thead><tbody>${hb}</tbody></table></div>
    <p class="dnote">붉을수록 필요 대비 초과 배치된 시간대(연두색 = 부족). 시프트 조정의 우선 대상입니다.</p></div>`;

  box.innerHTML = html;

  const saveBtn = $('fbSaveNotes');
  if (saveBtn) saveBtn.onclick = async () => {
    const rows = [];
    document.querySelectorAll('.fb-tag').forEach(sel2 => {
      if (!sel2.value) return;
      const memo = document.querySelector(`.fb-memo[data-date="${sel2.dataset.date}"]`)?.value || null;
      rows.push({ store_code: code, note_date: sel2.dataset.date, tag: sel2.value, memo, created_by: currentUser?.id });
    });
    const msg = $('fbNoteMsg');
    if (!rows.length) { msg.className = 'plan-msg err'; msg.textContent = '태그를 선택한 행이 없습니다.'; return; }
    const { error } = await sb.from('ot_day_notes').insert(rows);
    if (error) { msg.className = 'plan-msg err'; msg.textContent = '저장 실패: ' + error.message; }
    else { msg.className = 'plan-msg ok'; msg.textContent = `${rows.length}건 저장됨`; loadFeedback(); }
  };
}

// ---------- S4 실적 입력 (엑셀 업로드) ----------
function ymOf() { return $('acYm').value; }
function buildAcControls() {
  const mo = $('acYm');
  if (!mo || mo.options.length) return;
  for (let y = 2026, m = 8;;) {
    const v = `${y}-${String(m).padStart(2, '0')}`;
    const o = document.createElement('option'); o.value = v; o.textContent = `${y}년 ${m}월`; mo.appendChild(o);
    m++; if (m > 12) { m = 1; y++; } if (y === 2028) break;
  }
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  mo.value = [...mo.options].some(o => o.value === cur) ? cur : '2026-08';
}
function sheetRows(file) {
  return new Promise((res, rej) => {
    const rd = new FileReader();
    rd.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        res(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }));
      } catch (err) { rej(err); }
    };
    rd.onerror = rej;
    rd.readAsArrayBuffer(file);
  });
}
const isCode = v => /^RU\d{3}$/.test(String(v).trim());
function normDate(v) { // '2026-08-01' / '2026.8.1' / 엑셀 시리얼 문자열
  const s = String(v).trim().replace(/\./g, '-').replace(/\s.*$/, '');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}
const num = v => { const n = Number(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
function report(id, cls, txt) { const el = $(id); el.className = 'plan-msg ' + cls; el.innerHTML = txt; }
async function upsertChunks(table, rows, conflict) {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + 200), { onConflict: conflict });
    if (error) throw error;
  }
}

// ① 일별매출 (EATS 일자별 엑셀 그대로)
async function uploadSales(file) {
  report('acSalesMsg', '', '읽는 중…');
  try {
    const rows = (await sheetRows(file)).filter(r => isCode(r[0]) && normDate(r[2]));
    if (!rows.length) throw new Error('매장코드(RUxxx)+날짜 형식의 행을 찾지 못했습니다 — EATS 일자별 매출 원본인지 확인해주세요.');
    const out = [], perStore = {}, badCodes = new Set();
    rows.forEach(r => {
      const code = String(r[0]).trim();
      if (!OT_DATA[code]) { badCodes.add(code); return; }
      const d = normDate(r[2]);
      out.push({ store_code: code, sales_date: d, lunch: num(r[5]), dinner: num(r[6]), total: num(r[7]), guests: num(r[10]) || null });
      perStore[code] = (perStore[code] || 0) + 1;
    });
    const tot = out.reduce((t, r) => t + r.total, 0);
    await upsertChunks('ot_sales_daily', out, 'store_code,sales_date');
    report('acSalesMsg', 'ok', `저장됨: ${out.length}행 · ${Object.keys(perStore).length}개 매장 · 합계 ${(tot/1e8).toFixed(2)}억` +
      (badCodes.size ? ` <span style="color:var(--warn)">(미등록 코드 제외: ${[...badCodes].join(',')})</span>` : ''));
  } catch (e) { report('acSalesMsg', 'err', '실패: ' + e.message); }
}

// ② 메이트 급여대장 (시간 단위 '분', 야간·추가는 ×0.5 가산이라 MH 제외, 휴일근무는 배수 ≥1.0인 행만 가산)
async function uploadPayroll(file) {
  report('acPayMsg', '', '읽는 중…');
  try {
    const rows = (await sheetRows(file)).filter(r => isCode(r[0]));
    if (!rows.length) throw new Error('매장코드(RUxxx) 행을 찾지 못했습니다 — 메이트 급여대장 원본인지 확인해주세요.');
    const agg = {};
    rows.forEach(r => {
      const code = String(r[0]).trim();
      if (!OT_DATA[code]) return;
      const wage = num(r[10]);
      const nm = num(r[11]), npay = num(r[12]), hm = num(r[15]), hp = num(r[16]), total = num(r[24]);
      const w = wage || (nm > 0 ? npay / (nm / 60) : 0);
      const holH = (hm > 0 && w && (hp / (hm / 60)) / w >= 1.0) ? hm / 60 : 0;
      const a = (agg[code] = agg[code] || { pay: 0, mh: 0, n: 0 });
      a.pay += total; a.mh += nm / 60 + holH; a.n++;
    });
    const ym = ymOf();
    const out = Object.entries(agg).map(([code, a]) => ({
      store_code: code, ym, mate_pay: Math.round(a.pay), mate_mh: +a.mh.toFixed(1), source: `업로드 ${new Date().toISOString().slice(0, 10)}` }));
    await upsertChunks('ot_labor_monthly', out, 'store_code,ym');
    const totPay = out.reduce((t, r) => t + r.mate_pay, 0);
    report('acPayMsg', 'ok', `저장됨(${ym}): ${out.length}개 매장 · 인원 ${Object.values(agg).reduce((t,a)=>t+a.n,0)}명 · 급여 합계 ${(totPay/1e8).toFixed(2)}억`);
  } catch (e) { report('acPayMsg', 'err', '실패: ' + e.message); }
}

// ③ 출퇴근 기록부 → 일별·시간대별 투입 MH
async function uploadAtt(file) {
  report('acAttMsg', '', '읽는 중… (행이 많으면 수십 초 걸립니다)');
  try {
    const rows = (await sheetRows(file)).filter(r => /^\d{5,}$/.test(String(r[0]).trim()) && normDate(r[4]));
    if (!rows.length) throw new Error('사용자ID+근무일 형식의 행을 찾지 못했습니다 — 출퇴근 기록부 원본인지 확인해주세요.');
    const toCode = name => { for (const [k, c] of STORE_NAME_MAP) if (String(name).includes(k)) return c; return null; };
    const tmin = v => {
      const m = String(v).match(/(\d{1,2}):(\d{2})(?::\d{2})?$/);
      return m ? (+m[1]) * 60 + (+m[2]) : null;
    };
    const day = {};
    let skipped = 0;
    rows.forEach(r => {
      const code = toCode(r[2]);
      if (!code) { skipped++; return; }
      const th = num(r[10]);
      if (th <= 0) return;
      const d = normDate(r[4]);
      const key = code + '|' + d;
      const o = (day[key] = day[key] || { code, d, mate: 0, ft: 0, hours: Array(13).fill(0) });
      const bucket = FT_ROLE_SET.has(String(r[3]).trim()) ? 'ft' : 'mate';
      o[bucket] += th;
      const ai = tmin(r[6]), ao = tmin(r[8]);
      if (ai != null && ao != null && ao > ai) {
        const brk = num(r[13]);
        const span = (ao - ai) / 60;
        const f = span > 0 ? Math.max(0, (span - brk / 60) / span) : 0;
        for (let slot = 0; slot < 13; slot++) {
          const s0 = (9 + slot) * 60, s1 = (10 + slot) * 60;
          o.hours[slot] += Math.max(0, Math.min(ao, s1) - Math.max(ai, s0)) / 60 * f;
        }
      }
    });
    const out = Object.values(day).map(o => ({
      store_code: o.code, work_date: o.d, mate_mh: +o.mate.toFixed(2), ft_mh: +o.ft.toFixed(2),
      by_hour: o.hours.map(x => +x.toFixed(2)) }));
    await upsertChunks('ot_labor_daily', out, 'store_code,work_date');
    report('acAttMsg', 'ok', `저장됨: ${out.length}일분(매장×일) · 원본 ${rows.length}행` + (skipped ? ` · 매장 매핑 실패 ${skipped}행 제외` : ''));
  } catch (e) { report('acAttMsg', 'err', '실패: ' + e.message); }
}

// ---------- 초기화 (ot.js showView에서 진입 시 호출) ----------
function initActualViews() {
  buildFbControls();
  buildAcControls();
  const bind = (id, fn) => { const el = $(id); if (el && !el.dataset.bound) { el.dataset.bound = '1'; el.addEventListener('change', e => { if (e.target.files[0]) fn(e.target.files[0]); e.target.value = ''; }); } };
  bind('acSalesFile', uploadSales);
  bind('acPayFile', uploadPayroll);
  bind('acAttFile', uploadAtt);
}
