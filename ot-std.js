// 로운 OT — 표준 사용 계획표(F4): 파서·통계·월 산출·인건비율 상한. DOM 비의존.
// 원본 데이터는 DB(ot_standard_plans)에만 있다. 이 파일은 로직만.

// 전 매장 공통 인건비율 상한 (순매출 대비, 정직원 급여·연차·퇴직 포함) — 사용자 확정 2026-09-21
const LABOR_CAP = 0.38;
let OT_STD = {}; // { 매장코드: { weekday: plan, weekend: plan } }

// 밥차(직원 식사시간)는 근무 시간에서 제외 — 별도 집계(mealMH)만 한다 (사용자 확정 2026-09-21)
// 시간대별 투입(ot_labor_daily.by_hour): 예전 업로드 = 9~21시 13칸, 2026-10-28 이후 업로드 = 8~23시 16칸. h시의 값, 그 시간이 저장 범위 밖이면 null.
function hourIdx(arr, h) {
  if (!arr) return null;
  if (arr.length === 13) return (h >= 9 && h <= 21) ? arr[h - 9] : null;
  return (h >= 8 && h <= 8 + arr.length - 1) ? arr[h - 8] : null;
}
const STD_CATS = ["홀", "콜파트", "핫파트", "육절기", "프랩", "DMO", "관리·기타"];

// "6-27,30-31" → [6,7,...,27,30,31]   (슬롯 1 = 08:00, 30분 단위, 32 = 23:30)
function stdSlotsOf(str) {
  const out = [];
  String(str || "").split(",").filter(Boolean).forEach(seg => {
    const [a, b] = seg.split("-").map(Number);
    for (let i = a; i <= (b == null ? a : b); i++) out.push(i);
  });
  return out;
}
const stdSlotLabel = i => { const m = 8 * 60 + (i - 1) * 30; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + (m % 60 ? "30" : "00"); };

// 업무내용 → 파트 분류 ("밥차" = 직원 식사시간: 근무·인건비 제외)
function stdCat(name, part, ft) {
  const t = name || "";
  if (t.includes("밥차")) return "밥차";
  if (/DMO|디엠오|디에모|디\/폴/.test(t)) return "DMO";
  if (/육절|고기/.test(t) || (/육수/.test(t) && part === "주방")) return "육절기";
  if (/프렙|프랩|야채|토핑|식자재/.test(t)) return "프랩";
  if (/콜/.test(t)) return "콜파트";
  if (/핫/.test(t)) return "핫파트";
  if (/샐러드바|샐바|샐\/|홀|폴리싱|컨타|러너|베버|캐셔|대차|버싱|육수/.test(t)) return "홀";
  if (t) return "관리·기타";
  return ft ? "관리·기타" : (part === "주방" ? "관리·기타" : "홀");
}

// 시간×직원 표 셀 표시용 — "샐러드바/홀"처럼 겸업을 슬래시로 붙여 쓴 원본 텍스트는 앞부분만,
// DMO 표기 변형("디엠오"·"디에모")은 통일해서 짧게 보여준다. stdCat과 달리 분류하지 않고 원래 단어를 살린다.
function stdShort(t) {
  if (!t) return t;
  const s = String(t).split("/")[0].trim();
  return /^(DMO|디엠오|디에모)$/.test(s) ? "DMO" : s;
}

// 파트(홀/주방) — 원본에 파트가 없는 매장(해운대 등)은 그 사람이 한 업무 구성으로 정한다 (사용자 정의 2026-10-14:
// 홀 = 프리버싱·홀오픈·폴리싱·샐바 등, 주방 = 핫·콜·육절기·프랩·DMO·야채). 업무가 홀/주방으로 안 갈리면(마감·관리자 등) 역할명으로.
const STD_HALL_RE = /샐바|샐러드|프리버싱|버싱|홀|폴리싱|사이드|쇼케이스|캐셔|러너|컨타|베버|디저트/;
const STD_KITCHEN_RE = /핫|콜|육절|프랩|프렙|DMO|디엠오|디에모|야채|육수|토핑|고기/;
function stdPartOf(taskAt, slots, role) {
  const pick = t => (!t || t.includes("밥차")) ? null : STD_HALL_RE.test(t) ? "홀" : STD_KITCHEN_RE.test(t) ? "주방" : null;
  let h = 0, k = 0;
  slots.forEach(i => { const p = pick(taskAt[i] || role); if (p === "홀") h++; else if (p === "주방") k++; });
  if (h === k) return pick(role) || "";
  return h > k ? "홀" : "주방";
}
// 화면 정렬 키 — 홀 관리자 → 홀 메이트 → 주방 관리자 → 주방 메이트 (파트 미분류 정직원은 맨 앞, 미분류 메이트는 맨 뒤)
const stdBlockRank = b => {
  const base = b.p === "홀" ? 0 : b.p === "주방" ? 2 : null;
  if (base === null) return b.ft ? -1 : 4;
  return base + (b.ft ? 0 : 1);
};
const stdBlockSort = (a, b) => (stdBlockRank(a) - stdBlockRank(b)) || (a.slots[0] - b.slots[0]);

// DB 레코드 1건(평일 또는 주말) → 파싱 + 통계
function stdPrepare(rec) {
  const blocks = (rec.blocks || []).map(b => {
    const taskAt = {};
    String(b.t || "").split(";").filter(Boolean).forEach(seg => {
      const [name, rng] = seg.split("@");
      stdSlotsOf(rng).forEach(i => { taskAt[i] = name; });
    });
    const slots = stdSlotsOf(b.s);
    return { p: b.p || (b.ft ? "" : stdPartOf(taskAt, slots, b.r)), r: b.r, n: b.n, ft: !!b.ft, slots, taskAt };
  });
  const cnt = { all: Array(34).fill(0), ft: Array(34).fill(0), mate: Array(34).fill(0) };
  const cat = {}; STD_CATS.forEach(c => { cat[c] = Array(34).fill(0); });
  let ftSlots = 0, mateSlots = 0, mealSlots = 0;
  blocks.forEach(b => b.slots.forEach(i => {
    const c = stdCat(b.taskAt[i], b.p, b.ft);
    if (c === "밥차") { mealSlots++; return; } // 식사시간 — 근무 인원·MH에 넣지 않음
    cnt.all[i]++; (b.ft ? cnt.ft : cnt.mate)[i]++;
    if (b.ft) ftSlots++; else mateSlots++;
    cat[c][i]++;
  }));
  // 1시간 단위 행 (08~23시): 두 개의 30분 슬롯 평균
  const hours = [];
  for (let h = 8; h <= 23; h++) {
    const a = 2 * (h - 8) + 1, b = a + 1;
    const avg = arr => (arr[a] + arr[b]) / 2;
    const row = { h, label: String(h).padStart(2, "0") + ":00", need: avg(cnt.all), cov: avg(cnt.ft), mate: avg(cnt.mate), cats: {} };
    STD_CATS.forEach(c => { row.cats[c] = avg(cat[c]); });
    if (row.need > 0) hours.push(row);
  }
  return {
    id: rec.id, dayType: rec.day_type, version: rec.version, verified: !!rec.verified,
    blocks,
    stats: {
      ftMH: ftSlots / 2, mateMH: mateSlots / 2, totMH: (ftSlots + mateSlots) / 2, mealMH: mealSlots / 2,
      nFt: blocks.filter(b => b.ft).length, nMate: blocks.filter(b => !b.ft).length,
      cnt, cat, hours
    }
  };
}

// 날짜 → 평일/주말 표 선택 (공휴일은 주말 표 사용)
const stdDayKey = x => (x.hol || x.wd >= 5) ? "weekend" : "weekday";

// 영업일 목록(open)에 표를 적용한 월 합계
function stdMonthMH(code, open) {
  const st = OT_STD[code];
  let mMH = 0, mMHhol = 0, ftMH = 0, nWd = 0, nWe = 0;
  for (const x of open) {
    const k = stdDayKey(x), sm = st[k].stats;
    if (x.hol) mMHhol += sm.mateMH; else mMH += sm.mateMH;
    ftMH += sm.ftMH;
    if (k === "weekend") nWe++; else nWd++;
  }
  return { mMH, mMHhol, ftMH, nWd, nWe };
}

// 인건비율 상한 적용 — 초과하면 메이트 MH만 비례 감축 (정직원·연차·퇴직은 고정)
function stdApplyCap(s, M, fullpay, mMH, mMHhol) {
  const net = M / 1.1, leaveMH = s.nfull * 8;
  const fixed = fullpay + s.nfull * 100000 + net * 0.006;
  const calc = (a, b) => (a + b * 1.5 + leaveMH) * s.effBase + fixed;
  const costBefore = calc(mMH, mMHhol), ratioBefore = costBefore / net * 100;
  if (costBefore <= LABOR_CAP * net) {
    return { mMH, mMHhol, capped: false, cutMH: 0, scale: 1, cost: costBefore, ratio: ratioBefore, ratioBefore, structural: false };
  }
  const mateVar = (mMH + mMHhol * 1.5) * s.effBase;
  const allow = LABOR_CAP * net - fixed - leaveMH * s.effBase;
  const f = mateVar > 0 ? Math.max(0, Math.min(1, allow / mateVar)) : 0;
  const nM = mMH * f, nH = mMHhol * f, cost = calc(nM, nH);
  return { mMH: nM, mMHhol: nH, capped: true, cutMH: (mMH + mMHhol) - (nM + nH), scale: f, cost, ratio: cost / net * 100, ratioBefore, structural: allow < 0 };
}
