// 공급 공용 — 로트 신호 판정과 숫자 서식. 공급 화면(supply.js)과 홈 점수판(home.js)이 같은 기준을 쓰도록 한곳에 둔다.

const num = (n, d = 0) => n == null || isNaN(n) ? '—' : Number(n).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
const won = n => n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('ko-KR');

// ---------- 신호 기준 (필요하면 여기 숫자만 바꾸면 된다) ----------
const SIG = {
  shelfWarnDays: 30,   // 유통기한 잔여가 이 일수 이하면 '주의'
  shortCritDays: 3,    // 핵심 자재 합산 재고일수가 이 미만이면 '위험'(재고 부족)
  shortWarnDays: 7     // 핵심 자재 합산 재고일수가 이 미만이면 '주의'
};
const CAT_CRIT = c => /평가감|소진불가/.test(c || '');   // 평가감 대상·반영중·완료, 유통기한 내 소진불가
const CAT_WARN = c => /출고부진/.test(c || '');

function lotSignal(l) {
  const why = []; let lv = 'g';
  const up = s => { if (s === 'r' || (s === 'y' && lv === 'g')) lv = s; };
  if (l.category && CAT_CRIT(l.category)) { up('r'); why.push(l.category); }
  if (l.expiry_date && l.shelf_days_left != null && l.shelf_days_left < 0) { up('r'); why.push(`유통기한 ${Math.abs(l.shelf_days_left)}일 경과`); }
  else if (l.gap_days != null && l.gap_days < 0 && l.stock_qty > 0) { up('r'); why.push(`유통기한 내 소진불가 (차이 ${num(l.gap_days)}일)`); }
  if (l.unused_fee > 0) { up('r'); why.push(`불용 보관비 ${won(l.unused_fee)}원 청구 예정`); }
  if (l.category && CAT_WARN(l.category)) { up('y'); why.push('출고부진'); }
  if (l.expiry_date && l.shelf_days_left != null && l.shelf_days_left >= 0 && l.shelf_days_left <= SIG.shelfWarnDays) { up('y'); why.push(`유통기한 ${l.shelf_days_left}일 남음`); }
  if (l.stock_qty > 0 && !(l.daily_out > 0)) { up('y'); why.push('출고 없음'); }
  return { lv, why: [...new Set(why)] };
}
const lvRank = { r: 0, y: 1, g: 2 };
