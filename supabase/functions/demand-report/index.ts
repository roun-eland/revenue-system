// 로운 수요 모니터링 — 4단계 월간 리포트 초안 생성 (Supabase Edge Function, Deno)
// 호출: 화면의 "초안 생성" 버튼(기획자 JWT) 또는 예약 실행(x-cron-secret = DB demand_private.cron_secret)
// body: { ym?: "YYYY-MM"(기본: 지난달), force?: boolean(승인된 리포트도 다시 만들기), noai?: boolean(AI 해설 생략) }
// 하는 일: ① 검색·고객 반응·점포 데이터를 모아 숫자 스냅샷을 만들고 ② 규칙으로 자동 요점을 뽑고 ③ AI(Gemini 무료 등급, 없으면 생략)로 해설을 쓴 뒤
//         demand_reports에 '초안'으로 저장한다. 이미 승인된 리포트는 force 없이는 덮어쓰지 않는다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const env = (n: string) => (Deno.env.get(n) ?? "").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kstYm = (d = new Date()) => { const k = new Date(d.getTime() + 9 * 3600 * 1000); return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}`; };
const addMonths = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, "0")}`; };
const pct = (a: number, b: number) => (b > 0 ? (a / b - 1) * 100 : null);
const fmt = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("ko-KR"));
const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

// 월 검색수 한 점: 그 달 실측이 있으면 실측, 없으면 데이터랩 지수를 가장 최근 실측 월에 맞춰 환산한 추정 (화면의 seriesFor와 같은 규칙)
function valueFor(act: Map<string, number | null>, ratio: Map<string, number>, ym: string) {
  const a = act.get(ym);
  if (a != null) return { v: a, actual: true };
  let scale: number | null = null;
  for (const m of [...act.keys()].sort().reverse()) { const av = act.get(m), rv = ratio.get(m); if (av && rv && av > 0 && rv > 0) { scale = av / rv; break; } }
  const r = ratio.get(ym);
  return r != null && scale ? { v: r * scale, actual: false } : null;
}

async function gemini(system: string, prompt: string, deadline: number) {
  const key = env("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY 없음");
  const models = [env("GEMINI_MODEL"), "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"].filter((x, i, a) => x && a.indexOf(x) === i);
  let last = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 8000) throw new Error(last || "AI 해설 시간 제한(약 95초) 초과");
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        signal: AbortSignal.timeout(Math.min(75000, left)),
        method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: 6000 } }),
      });
      if (r.ok) {
        const j = await r.json();
        const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
        if (text) return { text, model: String(j.modelVersion ?? model) };
        last = "빈 응답"; break;
      }
      const body = (await r.text()).replaceAll(key, "***");
      last = `Gemini(${model}) ${r.status}: ${body.replace(/\s+/g, " ").slice(0, 120)}`;
      if (r.status === 404) break;
      if (r.status === 429 || r.status >= 500) { if (/PerDay|per day|daily/i.test(body)) break; await sleep(Math.min(8000, Math.max(0, deadline - Date.now() - 10000))); continue; }
      break;
    }
  }
  throw new Error(last || "Gemini 호출 실패");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const cron = req.headers.get("x-cron-secret");
    let ok = false, who = "자동";
    if (cron) {
      const { data: sec } = await createClient(SUPABASE_URL, SERVICE_KEY).from("demand_private").select("value").eq("key", "cron_secret").maybeSingle();
      ok = !!sec && sec.value === cron;
    }
    if (!ok) {
      const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
      const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
      const { data: { user: u } } = await user.auth.getUser(jwt);
      if (!u) return json({ error: "로그인이 필요합니다." }, 401);
      const { data: prof } = await user.from("ot_profiles").select("role").eq("user_id", u.id).maybeSingle();
      if (!prof || prof.role !== "planner") return json({ error: "기획자 계정만 실행할 수 있습니다." }, 403);
      who = u.email ?? "기획자";
    }
    const t0 = Date.now();
    const body = await req.json().catch(() => ({}));
    const ym: string = /^\d{4}-\d{2}$/.test(body.ym ?? "") ? body.ym : addMonths(kstYm(), -1);
    const prevYm = addMonths(ym, -1);
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: existing } = await admin.from("demand_reports").select("status").eq("ym", ym).maybeSingle();
    if (existing?.status === "approved" && !body.force) return json({ error: `${ym} 리포트는 이미 승인되어 있어 덮어쓰지 않았습니다. 다시 만들려면 '다시 생성(승인 해제)'을 사용하세요.` }, 409);

    // ---------- 데이터 모으기 ----------
    const [br, kw, sm, tr, rl, vs, sc, es] = await Promise.all([
      admin.from("demand_brands").select("id,name,kind,segment,status,ftc_brand_no").neq("status", "excluded").order("id"),
      admin.from("demand_keywords").select("id,keyword,grp,brand_id,active").eq("active", true),
      admin.from("demand_search_monthly").select("keyword_id,ym,total").limit(5000),
      admin.from("demand_trend").select("keyword_id,period,ratio").limit(10000),
      admin.from("demand_related").select("keyword_id,ym,related,total,rank").in("ym", [ym, prevYm]).limit(10000),
      admin.from("demand_voice_summary").select("*").in("ym", [ym, prevYm]),
      admin.from("demand_store_counts").select("*").in("source", ["ftc", "own"]),
      admin.from("demand_estimates").select("brand_id,metric,value,as_of,source_type,source_url,note").eq("status", "confirmed"),
    ]);
    const brands = br.data ?? [], kws = kw.data ?? [];
    const act = new Map<number, Map<string, number | null>>(), ratio = new Map<number, Map<string, number>>();
    for (const r of sm.data ?? []) { if (!act.has(r.keyword_id)) act.set(r.keyword_id, new Map()); act.get(r.keyword_id)!.set(r.ym, r.total); }
    for (const r of tr.data ?? []) { if (!ratio.has(r.keyword_id)) ratio.set(r.keyword_id, new Map()); ratio.get(r.keyword_id)!.set(String(r.period).slice(0, 7), Number(r.ratio)); }
    const point = (kid: number, m: string) => valueFor(act.get(kid) ?? new Map(), ratio.get(kid) ?? new Map(), m);

    // 검색: 브랜드(이름 키워드 중 가장 많이 검색되는 것), 시장·메뉴 키워드
    const searchBrands = brands.map((b) => {
      let best: { keyword: string; cur: { v: number; actual: boolean }; prev: { v: number; actual: boolean } | null } | null = null;
      for (const k of kws.filter((x) => x.brand_id === b.id && x.grp !== "need")) {
        const cur = point(k.id, ym); if (!cur) continue;
        if (!best || cur.v > best.cur.v) best = { keyword: k.keyword, cur, prev: point(k.id, prevYm) };
      }
      return best ? { brand_id: b.id, name: b.name, kind: b.kind, keyword: best.keyword, total: Math.round(best.cur.v), actual: best.cur.actual, prev: best.prev ? Math.round(best.prev.v) : null, mom: best.prev ? r1(pct(best.cur.v, best.prev.v)) : null } : null;
    }).filter(Boolean).sort((a, b) => b!.total - a!.total).map((x, i) => ({ ...x!, rank: i + 1 }));
    const kwRows = (grp: string) => kws.filter((k) => k.grp === grp).map((k) => { const c = point(k.id, ym), p = point(k.id, prevYm); return c ? { keyword: k.keyword, total: Math.round(c.v), actual: c.actual, prev: p ? Math.round(p.v) : null, mom: p ? r1(pct(c.v, p.v)) : null } : null; }).filter(Boolean).sort((a, b) => b!.total - a!.total);
    const market = kwRows("market"), needs = kwRows("need");
    // 급상승·신규 연관어(월 검색수 5천 이상)
    const kwName = new Map(kws.map((k) => [k.id, k.keyword]));
    const prevRel = new Map((rl.data ?? []).filter((r) => r.ym === prevYm).map((r) => [`${r.keyword_id}|${r.related}`, r.total ?? 0]));
    const rising = (rl.data ?? []).filter((r) => r.ym === ym && (r.total ?? 0) >= 5000).map((r) => {
      const p = prevRel.get(`${r.keyword_id}|${r.related}`);
      return { base: kwName.get(r.keyword_id) ?? "", related: r.related, total: r.total ?? 0, prev: p ?? null, mom: p ? r1(pct(r.total ?? 0, p)) : null, isNew: p == null && prevRel.size > 0 };
    }).filter((x) => x.isNew || (x.mom != null && x.mom >= 50)).sort((a, b) => b.total - a.total).slice(0, 12);

    // 고객 반응
    const voice = brands.map((b) => {
      const s = (vs.data ?? []).find((x) => x.brand_id === b.id && x.ym === ym);
      const p = (vs.data ?? []).find((x) => x.brand_id === b.id && x.ym === prevYm);
      if (!s) return null;
      const np = s.neg_items != null && s.sample_size > 0 ? r1((s.neg_items / s.sample_size) * 100) : null;
      const pp = p && p.neg_items != null && p.sample_size > 0 ? r1((p.neg_items / p.sample_size) * 100) : null;
      return { brand_id: b.id, name: b.name, kind: b.kind, n_items: s.n_items, sample_size: s.sample_size, neg_items: s.neg_items, neg_pct: np, neg_pct_prev: pp, headline: s.headline, positives: (s.positives ?? []).slice(0, 3), negatives: (s.negatives ?? []).slice(0, 3), features: (s.features ?? []).slice(0, 4), flags: s.flags ?? [] };
    }).filter(Boolean);

    // 점포: 우리=내부 매출 시스템, 경쟁사=공정위 정보공개서(연 단위, 영업현황은 기준년도 전년 말) + 사람이 확정한 최신 확인값(출처·기준일 병기)
    const latestEst = (id: number, metric: string) => (es.data ?? []).filter((e) => e.brand_id === id && e.metric === metric).sort((a, c) => String(c.as_of ?? "").localeCompare(String(a.as_of ?? "")))[0];
    const stores = brands.map((b) => {
      const ls = latestEst(b.id, "stores"), lv = latestEst(b.id, "avg_sales");
      const extra = { latest: ls ? { value: Number(ls.value), as_of: ls.as_of, type: ls.source_type, url: ls.source_url } : null, latest_sales: lv ? { value: Number(lv.value), as_of: lv.as_of, type: lv.source_type, url: lv.source_url } : null };
      return { ...storeRow(b), ...extra };
    });
    function storeRow(b: { id: number; name: string; kind: string }) {
      const rows = (sc.data ?? []).filter((r) => r.brand_id === b.id && r.area === "전체");
      const own = rows.filter((r) => r.source === "own").sort((a, c) => String(c.period).localeCompare(String(a.period)))[0];
      if (own) return { brand_id: b.id, name: b.name, kind: b.kind, source: "내부 매출 시스템", total: own.total, frcs: 0, dms: own.total, period: own.period, yoy: null, open_12m: own.open_12m, avg_sales_ttm: own.avg_sales_ttm };
      const f = rows.filter((r) => r.source === "ftc").sort((a, c) => String(c.period).localeCompare(String(a.period)));
      if (!f.length) return { brand_id: b.id, name: b.name, kind: b.kind, source: "확인 불가", total: null, period: null };
      const prev = f.find((r) => Number(r.period) < Number(f[0].period) && r.total > 0); // 신규 등록 전(0개) 연도는 증감 비교에서 제외
      return { brand_id: b.id, name: b.name, kind: b.kind, source: "공정위 정보공개서", total: f[0].total, frcs: f[0].frcs, dms: f[0].dms, period: f[0].period, asof: `${Number(f[0].period) - 1}년 말`, yoy: prev ? f[0].total - prev.total : null };
    }

    // ---------- 자동 요점(규칙) ----------
    const hl: string[] = [];
    const own = searchBrands.find((x) => x.kind === "own");
    if (own) hl.push(`${own.name}(\"${own.keyword}\") 월 검색수는 ${fmt(own.total)}${own.actual ? "" : "(추정)"}으로 모니터링 브랜드 ${searchBrands.length}곳 중 ${own.rank}위${own.mom != null ? `, 전월 대비 ${own.mom >= 0 ? "+" : ""}${own.mom}%` : ""}입니다.`);
    const movers = searchBrands.filter((x) => x.mom != null && x.kind !== "own").sort((a, b) => Math.abs(b.mom!) - Math.abs(a.mom!));
    if (movers[0]) hl.push(`경쟁사 중 검색 변화가 가장 큰 곳은 ${movers[0].name}(${movers[0].mom! >= 0 ? "+" : ""}${movers[0].mom}%, ${fmt(movers[0].total)})입니다.`);
    const mk = market.filter((x) => x!.mom != null).sort((a, b) => Math.abs(b!.mom!) - Math.abs(a!.mom!))[0];
    if (mk) hl.push(`시장 키워드 중 변화가 가장 큰 것은 \"${mk.keyword}\" ${mk.mom! >= 0 ? "+" : ""}${mk.mom}%(${fmt(mk.total)})입니다.`);
    if (rising.length) hl.push(`급상승·신규 연관어: ${rising.slice(0, 4).map((x) => `${x.related}${x.mom != null ? ` ${x.mom >= 0 ? "+" : ""}${x.mom}%` : "(신규)"}`).join(", ")}.`);
    const vo = voice.find((x) => x!.kind === "own");
    const comp = voice.filter((x) => x!.kind !== "own" && x!.neg_pct != null && (x!.sample_size ?? 0) >= 20);
    if (vo && vo.neg_pct != null) {
      const avg = comp.length ? comp.reduce((a, x) => a + x!.neg_pct!, 0) / comp.length : null;
      hl.push(`${vo.name} 부정 비중은 ${vo.neg_pct}%(${vo.neg_items}/${vo.sample_size}건)${vo.neg_pct_prev != null ? `, 전월 ${vo.neg_pct_prev}%` : ""}${avg != null ? `이고, 표본 20건 이상인 경쟁사 평균은 ${r1(avg)}%입니다` : "입니다"}.`);
    }
    const worst = [...comp].sort((a, b) => b!.neg_pct! - a!.neg_pct!)[0];
    if (worst) hl.push(`경쟁사 중 부정 비중이 가장 높은 곳은 ${worst.name} ${worst.neg_pct}%(${worst.neg_items}/${worst.sample_size}건)입니다.`);
    const fl = voice.filter((x) => (x!.flags ?? []).length).map((x) => `${x!.name}: ${(x!.flags as string[]).slice(0, 2).join("; ")}`);
    if (fl.length) hl.push(`주의 신호 — ${fl.join(" / ")}`);
    const st = stores.filter((x) => x.source === "공정위 정보공개서" && x.yoy != null).sort((a, b) => (b.yoy as number) - (a.yoy as number))[0];
    if (st) hl.push(`경쟁사 점포 수(공정위 ${st.asof} 기준) 증가가 가장 큰 곳은 ${st.name} +${st.yoy}개(${fmt(st.total)}개)입니다.`);
    const lat = stores.filter((x) => x.kind !== "own" && x.latest).sort((a, b) => b.latest!.value - a.latest!.value).slice(0, 3);
    if (lat.length) hl.push(`최근 확인된 경쟁사 점포 수(언론·공식 자료, 출처 병기): ${lat.map((x) => `${x.name} ${fmt(x.latest!.value)}개(${String(x.latest!.as_of ?? "시점 미상").slice(0, 7)} 기준)`).join(", ")}.`);
    const so = stores.find((x) => x.kind === "own");
    if (so && so.total != null) hl.push(`${so.name} 현황: ${so.total}개 직영점(최근 12개월 신규 ${so.open_12m ?? 0}개), 점포당 연매출 약 ${so.avg_sales_ttm ? (so.avg_sales_ttm / 1e8).toFixed(1) + "억" : "—"}입니다.`);

    const snapshot = {
      ym, prevYm,
      search: { brands: searchBrands, market, needs, rising },
      voice, stores,
      limits: [
        "월 검색수는 네이버 검색광고 값이며 수집 전 달은 데이터랩 지수로 환산한 추정입니다.",
        "고객 반응은 블로그·뉴스·유튜브 표본을 AI가 읽은 결과이며, 카페글은 작성일이 없어 수집 시점 기준입니다.",
        "공정위 정보공개서 점포 수는 연 1회 갱신되며 영업현황은 기준년도 전년도 말 기준이라 최신과 차이가 큽니다. 일부 브랜드는 등록되지 않아 값이 없습니다.",
        "'최신 확인값'(점포 수·점포당 연매출)은 언론·공식 자료에서 기획자가 출처와 기준일을 확인해 확정한 값이며 매체마다 집계 기준이 다를 수 있습니다. 확정한 값이 없는 브랜드는 비워 두었습니다.",
      ],
    };

    // 숫자 초안을 먼저 저장해 두고(AI가 느리거나 실패해도 남도록), AI 해설은 시간 제한 안에서 덧붙인다.
    const row = { ym, status: "draft", title: `${ym} 시장·경쟁사 월간 리포트`, data: snapshot, highlights: hl, narrative: null as unknown, model: null as string | null, generated_at: new Date().toISOString(), edited_at: null, approved_at: null, approved_by: null };
    const { error } = await admin.from("demand_reports").upsert(row);
    if (error) return json({ error: "저장 실패: " + error.message }, 500);

    // ---------- AI 해설 ----------
    let narrative: unknown = null, model: string | null = null, aiNote = "";
    if (!body.noai && env("GEMINI_API_KEY")) {
      try {
        const compact = JSON.stringify({ month: ym, search_brands: searchBrands, market_keywords: market, need_keywords: needs, rising_related: rising,
          voice: voice.map((v) => ({ name: v!.name, kind: v!.kind, n: v!.n_items, neg_pct: v!.neg_pct, neg_prev: v!.neg_pct_prev, headline: v!.headline, pos: (v!.positives as { theme: string }[]).map((x) => x.theme), neg: (v!.negatives as { theme: string }[]).map((x) => x.theme), flags: v!.flags })),
          stores, auto_highlights: hl }).slice(0, 24000);
        const prompt = `아래는 외식 브랜드 '로운샤브'(우리)와 경쟁사의 ${ym} 월간 모니터링 데이터다. 경영진용 월간 시장·경쟁사 리포트의 해설을 써라.
규칙: 1) 주어진 숫자와 사실만 근거로 쓴다. 없는 수치·원인을 만들지 않는다. 2) 추정(estimate) 값, 표본이 작은 값(n<20)은 단정하지 말고 한계를 짚는다. 3) 고객 반응의 인과를 단정하지 않는다. 4) 한국어, 간결하게. 5) stores의 source가 '공정위 정보공개서'인 값은 asof(전년도 말) 기준의 오래된 값이고, latest(확정된 최신 확인값)가 있으면 그것을 현재 규모로 보고 둘의 시점 차이를 구분해 쓴다.
출력 JSON만: {"headline":"한 문장 총평","summary":["핵심 3~5개 문장"],"insights":{"search":"검색·관심도 해석 2~3문장","voice":"고객 반응 해석 2~3문장","stores":"점포·규모 해석 2~3문장"},"risks":["주의·리스크 0~3개"],"actions":["우리가 점검·검토할 일 2~4개(제안 형태)"]}
데이터: ${compact}`;
        const out = await gemini("너는 외식 프랜차이즈 시장조사 담당 애널리스트다. 주어진 데이터만 근거로 정확하고 신중하게 해설하고, 지정한 JSON 형식으로만 답한다.", prompt, t0 + 95000);
        const m = out.text.match(/\{[\s\S]*\}/);
        if (m) { narrative = JSON.parse(m[0]); model = out.model; } else aiNote = "AI 응답에서 JSON을 찾지 못했습니다.";
      } catch (e) { aiNote = "AI 해설 생략: " + (e as Error).message.slice(0, 140); }
      if (narrative) await admin.from("demand_reports").update({ narrative, model }).eq("ym", ym);
    } else if (!body.noai) aiNote = "GEMINI_API_KEY가 없어 AI 해설은 생략했습니다.";
    return json({ ok: true, ym, by: who, highlights: hl.length, ai: !!narrative, note: aiNote, summary: `${ym} 리포트 초안을 만들었습니다 (요점 ${hl.length}개${narrative ? ", AI 해설 포함" : ", AI 해설 없음"}).${aiNote ? " " + aiNote : ""}` });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
