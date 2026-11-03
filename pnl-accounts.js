// 로운 예상실적 — 회계 계정 트리 (2026-11-03, 사용자 제공 계정표 그대로)
// 한 줄 = [단계, 이름, 옵션]. 단계 1=대분류(1. 2. 3.) · 2=중분류((1) (1-1)) · 3=소분류(① ②) · 4=세부(-).
//  id    : 계산에서 쓰는 계정의 고정 이름(바꾸면 안 됨). 없으면 위치로 코드가 정해진다(n1.2.3 …).
//  main  : "주요 계정" 보기에서 보이는 줄 (원본 손익표에서 값이 있는 계정)
//  calc  : 하위 합계가 아닌 계산식 — v('id')로 다른 계정 값을 읽는다
// ⚠ 위치로 정한 코드는 pnl_adjust(특이비용)에 저장된다 — 계정을 끼워 넣으면 어긋나므로 새 계정은 같은 단계의 맨 뒤에 추가할 것.
const PNL_TREE = [
  [1, '1. 매출액 (1)-(2)', { id: 'sales', main: 1, calc: v => v('gross') - v('vat') }],
  [2, '(1) 외형매출', { id: 'gross', main: 1 }],
  [3, '① 직영점매출'],
  [4, '①-1 직영점매출', { id: 'gross_direct' }],
  [4, '①-2 직영점매출(리워드)'],
  [3, '② 대리점매출'],
  [3, '③ 기타매출'],
  [2, '(2) 부가세', { id: 'vat' }],

  [1, '2. 매출원가 ((1)+(2)+(3))', { id: 'cogs', main: 1 }],
  [2, '(1) 상제품 매출원가', { calc: v => v('inv_begin') + v('inv_buy') - v('inv_end') }],
  [3, '① 기초재고', { id: 'inv_begin' }],
  [3, '② 당기매입액', { id: 'inv_buy' }],
  [3, '③ 기말재고', { id: 'inv_end' }],
  [2, '(1-1) 식재료원가', { main: 1 }],
  [3, '① 식재료원가(직영점원가)', { id: 'food', main: 1 }],
  [3, '② 상품매출원가(대리점원가)'],
  [3, '③ 의제매입세액 공제액', { id: 'food_tax', main: 1 }],
  [3, '④ 재고평가손실'],
  [2, '(1-2) 제조인건비', { main: 1 }],
  [3, '① 급여_직원', { id: 'pay_ft', main: 1 }],
  [3, '② 급여_아르바이트', { id: 'pay_pt', main: 1 }],
  [3, '③ 성과상여'],
  [3, '④ 퇴직급여', { id: 'retire', main: 1 }],
  [2, '(1-3) 제조경비', { main: 1 }],
  [3, '① 복리후생비', { main: 1 }],
  [3, '② 여비교통비'],
  [3, '③ 소모품비', { main: 1 }],
  [3, '④ 견본비', { main: 1 }],
  [3, '⑤ 수도광열비', { main: 1 }],
  [3, '⑥ 운반비', { main: 1 }],
  [3, '⑦ 감가상각비', { main: 1 }],
  [4, '- 감가상각비'],
  [4, '- 감가상각비-조정(IFRS16_리스)'],
  [4, '- 감가상각비-조정(IFRS16_복구)'],
  [3, '⑧ 세금과공과', { main: 1 }],
  [3, '⑨ 지급수수료'],
  [3, '⑩ 기타제조경비', { main: 1 }],
  [2, '(2) 재고자산 폐기손실'],
  [2, '(3) 기타매출원가'],
  [2, '(4) 사내매출원가'],

  [1, '3. 매출총이익 ( 1 - 2 )', { id: 'gp', main: 1, calc: v => v('sales') - v('cogs') }],

  [1, '4. 판매비와 관리비', { id: 'sga', main: 1 }],
  [3, '① 급여'],
  [3, '② 성과상여'],
  [3, '③ 퇴직급여'],
  [3, '④ 판매수수료(유통마진)'],
  [4, '- 판매수수료 (유통마진)'],
  [4, '- 판매수수료 (유통마진)-조정(IFRS16)'],
  [3, '⑤ 판매수수료(인건비)'],
  [3, '⑥ 복리후생비'],
  [3, '⑦ 운반비'],
  [3, '⑧ 광고선전비', { main: 1 }],
  [3, '⑨ 수도광열비'],
  [3, '⑩ 소모품비'],
  [3, '⑪ 지급수수료', { main: 1 }],
  [4, '- 지급수수료'],
  [4, '- 지급수수료-조정(IFRS16)_복구비대체'],
  [3, '⑫ 지급임차료', { main: 1 }],
  [4, '- 지급임차료'],
  [4, '- 지급임차료-조정(IFRS16)'],
  [3, '⑬ 세금과공과'],
  [3, '⑭ 감가상각비'],
  [4, '- 감가상각비'],
  [4, '- 감가상각비-조정(IFRS16)_리스'],
  [4, '- 감가상각비-조정(IFRS16)_복구비'],
  [3, '⑮ 기타판관비'],
  [4, '- 기타판관비'],
  [4, '- 기타판관비-사내거래수수료'],

  [1, '5. 영업이익 ( 3 - 4 )', { id: 'op', main: 1, calc: v => v('gp') - v('sga') }],

  [1, '6. 기타영업외손익 (1-2+3)', { id: 'other', calc: v => v('oth_gain') - v('oth_loss') + v('oth_div') }],
  [3, '① 기타영업이익', { id: 'oth_gain' }],
  [3, '② 기타영업손실', { id: 'oth_loss' }],
  [3, '③ 관계사 배당수익', { id: 'oth_div' }],
  [1, '7. 금융손익 (① - ②)', { id: 'fin', calc: v => v('int_inc') - v('fin_cost') }],
  [3, '① 이자수익', { id: 'int_inc' }],
  [3, '② 금융비용', { id: 'fin_cost' }],
  [1, '8. 법인세비용차감전순이익 ( 5 + 6 + 7 )', { id: 'pretax', calc: v => v('op') + v('other') + v('fin') }],
  [1, '9. 법인세비용(값)', { id: 'tax_val' }],
  [1, '9. 법인세비용', { id: 'tax', calc: v => v('tax_val') }],
  [1, '10. 당기순이익 ( 8 - 9 )', { id: 'net', calc: v => v('pretax') - v('tax') }]
];

// 평평한 목록으로 펼친다 — { code, label, level, parent, children, main, calc, id, leaf, path }
const PNL_ACC = [];
const PNL_BY = {};
const PNL_ID = {};
(function () {
  const stack = [];                // 단계별 마지막 노드
  const ord = {};                  // 부모 코드 → 자식 개수
  for (const [level, label, o] of PNL_TREE) {
    const opt = o || {};
    let parent = null;             // 바로 윗단계가 없으면(4. 판관비의 ① … 은 2단계 없이 1단계 밑) 가장 가까운 윗단계를 부모로 잡는다
    for (let l = level - 1; l >= 1 && !parent; l--) parent = stack[l] || null;
    const pcode = parent ? parent.code : 'n';
    ord[pcode] = (ord[pcode] || 0) + 1;
    const code = opt.id || `${pcode}.${ord[pcode]}`;
    const node = { code, label, level, parent: parent ? parent.code : null, children: [], main: !!opt.main, calc: opt.calc || null, id: opt.id || null };
    if (parent) parent.children.push(code);
    stack[level] = node; stack.length = level + 1;
    PNL_ACC.push(node); PNL_BY[code] = node;
    if (opt.id) PNL_ID[opt.id] = code;
  }
  for (const a of PNL_ACC) { a.leaf = !a.children.length && !a.calc; }
})();
