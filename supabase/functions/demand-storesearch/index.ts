// 로운 수요 모니터링 — 경쟁사 점포 수 '최신 확인값' 후보 수집 (Supabase Edge Function, Deno)
// 호출: 화면의 "검색으로 후보 찾기"(기획자 JWT) 또는 예약 실행(x-cron-secret = DB demand_private.cron_secret)
// body: { offset?: number(기본 0), limit?: number(기본 4), brand_id?: number, debug?: boolean }
// 하는 일: 경쟁사별로 네이버 뉴스 검색(API HUB)에서 기사 제목·요약을 모아, 점포 수·점포당 평균 매출이 적힌 문장만 AI(Gemini)가 읽고
//         (값, 기준일, 출처 기사, 인용문)을 뽑아 demand_estimates에 '후보'로 저장한다. 사람이 확정해야 화면·리포트에 반영된다.
// 한계: 기사 요약(약 100자)에 숫자가 있는 경우만 잡히고, 매체마다 집계 시점·기준이 달라 값이 다를 수 있어 자동 확정하지 않는다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const env = (n: string) => (Deno.env.get(n) ?? "").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
// 검색에 쓸 이름(등록명과 기사 표기가 다른 브랜드)
const ALIAS: Record<string, string> = { "샤브보트R": "샤브보트" };
// 점포 수 / 점포당 평균 매출이 적혀 있을 법한 문장만 AI에게 보낸다(날짜순 검색은 잡음이 많아 먼저 걸러야 한다)
const STORE_RE = /(매장|가맹점|점포|호점|직영)[^.]{0,24}\d[\d,]*\s*(개|곳|호점|점)|\d[\d,]*\s*(개|곳|호점)[^.]{0,14}(매장|가맹점|점포)/;
const SALES_RE = /(평균\s*매출|점당\s*매출|한\s*곳당\s*(평균\s*)?매출|연\s*평균\s*매출|평균\s*연매출)/;

async function news(q: string, sort: "date" | "sim") {
  const id = env("NAVERSEARCH_CLIENT_ID") || env("NAVERHUB_CLIENT_ID");
  const sec = env("NAVERSEARCH_CLIENT_SECRET") || env("NAVERHUB_CLIENT_SECRET");
  const r = await fetch(`https://naverapihub.apigw.ntruss.com/search/v1/news?query=${encodeURIComponent(q)}&display=60&start=1&sort=${sort}`, { headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": sec } });
  if (!r.ok) throw new Error(`네이버 뉴스 검색 ${r.status}: ${(await r.text()).slice(0, 100)}`);
  // deno-lint-ignore no-explicit-any
  return ((await r.json()).items ?? []) as any[];
}

async function gemini(system: string, prompt: string, deadline: number) {
  const key = env("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY 없음");
  const models = [env("GEMINI_MODEL"), "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"].filter((x, i, a) => x && a.indexOf(x) === i);
  let last = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 8000) throw new Error(last || "AI 시간 제한 초과");
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        signal: AbortSignal.timeout(Math.min(75000, left)), method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 6000 } }),
      });
      if (r.ok) {
        const j = await r.json();
        const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
        if (text) return text;
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
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    let q = admin.from("demand_brands").select("id,name").eq("kind", "competitor").neq("status", "excluded").order("id");
    if (body.brand_id) q = q.eq("id", body.brand_id);
    const { data: all } = await q;
    const list = all ?? [];
    const offset = Math.max(0, Number(body.offset) || 0), limit = Math.max(1, Math.min(8, Number(body.limit) || 4));
    const batch = list.slice(offset, offset + limit);
    if (!batch.length) return json({ ok: true, by: who, done: true, remaining: 0, summary: "처리할 브랜드가 없습니다." });

    // 1) 기사 모으기: 점포 수 숫자가 들어 있고 브랜드명이 언급된 기사만 남긴다
    // deno-lint-ignore no-explicit-any
    const pack: Array<{ brand: { id: number; name: string }; items: any[] }> = [];
    for (const b of batch) {
      const nm = ALIAS[b.name] ?? b.name;
      const seen = new Map<string, { n: number; title: string; desc: string; url: string; date: string }>();
      for (const [kw, sort] of [[`"${nm}" 매장 수`, "sim"], [`"${nm}" 가맹점 평균 매출`, "sim"], [`"${nm}" 호점 돌파`, "sim"], [`"${nm}" 폐업`, "date"], [`"${nm}" 매장`, "date"]] as const) {
        try {
          for (const it of await news(kw, sort)) {
            const title = strip(it.title), desc = strip(it.description), url = it.originallink || it.link;
            const txt = `${title} ${desc}`;
            if (!txt.replace(/\s/g, "").includes(nm.replace(/\s/g, "")) || !(STORE_RE.test(txt) || SALES_RE.test(txt)) || seen.has(url)) continue;
            seen.set(url, { n: seen.size + 1, title, desc, url, date: it.pubDate ? new Date(it.pubDate).toISOString().slice(0, 10) : "" });
          }
        } catch (e) { if (!seen.size) throw e; }
        await sleep(250);
      }
      pack.push({ brand: b, items: [...seen.values()].sort((a, c) => c.date.localeCompare(a.date)).slice(0, 24) });
    }

    // 2) AI가 기사 문장에서 '현재 전국 총 점포 수'만 뽑는다
    const withItems = pack.filter((p) => p.items.length);
    let saved = 0, note = "";
    if (withItems.length) {
      const data = withItems.map((p) => ({ brand_id: p.brand.id, brand: p.brand.name, articles: p.items.map((x, i) => ({ i, date: x.date, title: x.title, text: x.desc })) }));
      const prompt = `아래는 외식 브랜드별 뉴스 기사 제목·요약이다. 각 브랜드의 ① '전국 총 매장(점포) 수'(metric "stores", 단위 개) ② '점포(가맹점) 한 곳당 평균 매출'(metric "avg_sales", 값은 억원 단위 숫자로 환산, 예: 36억863만원→36.1)이 명시된 문장만 골라 뽑아라.
규칙: 1) 기사에 적힌 숫자만 쓴다. 추측·계산 금지(avg_sales의 억원 환산만 허용). 2) 해외 매장, 특정 지역·지점 수, 목표·계획(예: 'OO개 목표'), 가맹점만의 수(직영 제외라고 명시된 경우)는 제외한다. 3) 같은 브랜드 후보는 기준 시점이 가장 최근인 것 위주로 최대 5개, 서로 다른 값만(기사가 말하는 시점이 다르면 각각). 4) as_of는 기사 본문이 말한 기준 시점(YYYY-MM-DD, 일을 모르면 -01 또는 월말 추정 금지: 월만 알면 해당 월 1일)을 쓰고, 본문에 시점이 없으면 기사 date를 쓴다. 5) quote는 값이 나온 부분을 기사 텍스트에서 그대로 20~60자 인용한다.
출력 JSON만: {"items":[{"brand_id":숫자,"metric":"stores"|"avg_sales","value":숫자,"as_of":"YYYY-MM-DD","article":기사번호i,"quote":"인용"}]}  해당 없으면 {"items":[]}
데이터: ${JSON.stringify(data).slice(0, 48000)}`;
      try {
        const text = await gemini("너는 기사에서 수치를 정확히 추출하는 조사원이다. 기사에 없는 값은 만들지 않고 지정한 JSON으로만 답한다.", prompt, t0 + 100000);
        const m = text.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : { items: [] };
        const rows = [];
        for (const x of parsed.items ?? []) {
          const p = withItems.find((w) => w.brand.id === Number(x.brand_id));
          const art = p?.items[Number(x.article)];
          const v = Number(x.value), metric = x.metric === "avg_sales" ? "avg_sales" : "stores";
          const flat = (t: string) => t.replace(/[\s,'"“”‘’.…·]/g, "");
          if (!p || !art || !(v > 0 && v < (metric === "stores" ? 5000 : 1000))) continue;
          const full = flat(art.title + art.desc);
          // 환각 방지: 점포 수는 그 숫자가 기사 텍스트에 있어야 하고, 매출(억원 환산)은 인용문이 기사 텍스트에 그대로 있어야 한다
          if (metric === "stores" ? !full.includes(String(v)) : !(flat(String(x.quote ?? "")).length >= 8 && full.includes(flat(String(x.quote ?? ""))))) continue;
          const asOf = /^\d{4}-\d{2}-\d{2}$/.test(x.as_of ?? "") ? x.as_of : art.date || null;
          rows.push({ brand_id: p.brand.id, metric, value: v, unit: metric === "stores" ? "개" : "억원", as_of: asOf, source_url: art.url, source_title: art.title.slice(0, 200), source_type: "news", quote: String(x.quote ?? "").slice(0, 200), status: "candidate" });
        }
        if (rows.length) {
          const { data: ins, error } = await admin.from("demand_estimates").upsert(rows, { onConflict: "brand_id,metric,source_url,value", ignoreDuplicates: true }).select("id");
          if (error) throw new Error("저장 실패: " + error.message);
          saved = (ins ?? []).length;
        }
      } catch (e) { note = "AI 추출 실패: " + (e as Error).message.slice(0, 140); }
    }
    const next = offset + batch.length;
    return json({ ok: !note, by: who, done: next >= list.length, remaining: Math.max(0, list.length - next), next, brands: batch.map((b) => b.name), articles: pack.map((p) => `${p.brand.name} ${p.items.length}`), saved, note, sample: body.debug ? pack.map((p) => p.items.slice(0, 6).map((x) => `${x.date} ${x.title} | ${x.desc.slice(0, 90)}`)) : undefined,
      summary: `${batch.map((b) => b.name).join("·")}: 기사 ${pack.reduce((s, p) => s + p.items.length, 0)}건 검토, 새 후보 ${saved}건${note ? " — " + note : ""}` });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
