// 로운 수요 모니터링 — 3단계 고객 반응 수집·요약 (Supabase Edge Function, Deno)
// 호출: 화면의 "지금 수집" 버튼(기획자 JWT) 또는 예약 실행(x-cron-secret = DB demand_private.cron_secret)
// body: { mode?: "collect" | "summarize" | "all"(기본), brand_id?: number, ym?: "YYYY-MM" }
// 기간: ym이 있으면 그 달에 발행된 글만, 없으면 지난달 + 이번 달(진행분). 모든 원문은 발행월에 귀속해 월별로 요약한다.
// 필요한 Secrets(있는 출처만 사용, 없으면 그 출처는 건너뜀):
//   YOUTUBE_API_KEY                      유튜브 영상·댓글
//   NAVERHUB_CLIENT_ID / _SECRET         네이버 블로그·뉴스·카페 검색 (NAVER API HUB에 '검색' API 등록 필요)
//     (검색 전용 Application을 따로 만들었다면 NAVERSEARCH_CLIENT_ID / _SECRET 이 우선)
//   GEMINI_API_KEY                       요약(무료 등급 가능, 선택: GEMINI_MODEL) — 있으면 이쪽을 우선 사용
//   ANTHROPIC_API_KEY                    요약 대체 수단 (선택: DEMAND_AI_MODEL)
//   요약은 호출 한도 때문에 ~105초 안에서 끊어 처리하고 남은 건수(remaining)를 돌려준다. 다시 호출하면 이어서 진행.
// 보관 원칙: 원문 조각(demand_voice_raw)은 28일 후 자동 삭제(유튜브 정책), 요약(demand_voice_summary)만 남긴다. 작성자 이름 등 개인정보는 저장하지 않는다.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const env = (n: string) => (Deno.env.get(n) ?? "").trim();
// deno-lint-ignore no-explicit-any
const ck = (r: any) => { if (r?.error) throw new Error(`DB 저장 실패: ${r.error.message}`); };
const nospace = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const strip = (s: string) =>
  String(s ?? "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
function kstYm(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}`;
}
// ---- 월 계산(한국시간 기준). 모든 원문은 '발행된 달'에 귀속시킨다 ----
const monthOf = (iso: string) => kstYm(new Date(iso));
const monthStart = (ym: string) => `${ym}-01T00:00:00+09:00`;
const addMonths = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, "0")}`; };
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}

type Brand = { id: number; name: string; kind: string; segment: string | null; aliases: string[] | null };
type Item = { source: string; title: string; snippet: string; url: string; posted_at: string | null; metric: Record<string, unknown> | null };

// 브랜드와 무관한 결과를 거르기 위해 이름(또는 별칭)이 제목·내용에 들어 있는 것만 쓴다
const matches = (b: Brand, text: string) => {
  const t = nospace(text);
  return [b.name, ...(b.aliases ?? [])].some((n) => n && t.includes(nospace(n)));
};

// ---------- 유튜브 ----------
async function yt(path: string, params: Record<string, string | number>) {
  const u = new URL("https://www.googleapis.com/youtube/v3/" + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  u.searchParams.set("key", env("YOUTUBE_API_KEY"));
  const r = await fetch(u);
  if (!r.ok) throw new Error(`YouTube ${path} ${r.status}: ${(await r.text()).replaceAll(env("YOUTUBE_API_KEY"), "***").slice(0, 160)}`);
  return await r.json();
}
// 월마다 따로 검색해 그 달에 올라온 영상만 가져온다
async function collectYoutube(b: Brand, months: string[]): Promise<Item[]> {
  const out: Item[] = [];
  for (const ym of months) {
    const after = new Date(monthStart(ym)).toISOString();
    const before = new Date(Math.min(new Date(monthStart(addMonths(ym, 1))).getTime(), Date.now())).toISOString();
    out.push(...await collectYoutubeMonth(b, after, before));
  }
  return out;
}
async function collectYoutubeMonth(b: Brand, after: string, before: string): Promise<Item[]> {
  const s = await yt("search", { part: "snippet", type: "video", q: `${b.name} 후기`, maxResults: 25, order: "relevance", publishedAfter: after, publishedBefore: before, regionCode: "KR", relevanceLanguage: "ko" });
  // deno-lint-ignore no-explicit-any
  const vids = (s.items ?? []).map((i: any) => ({ id: i.id.videoId as string, title: strip(i.snippet.title), desc: strip(i.snippet.description), at: i.snippet.publishedAt as string }))
    .filter((v: { title: string; desc: string }) => matches(b, v.title + " " + v.desc));
  if (!vids.length) return [];
  const st = await yt("videos", { part: "statistics", id: vids.map((v: { id: string }) => v.id).join(",") });
  // deno-lint-ignore no-explicit-any
  const stats = new Map<string, any>((st.items ?? []).map((i: any) => [i.id, i.statistics]));
  const items: Item[] = vids.map((v: { id: string; title: string; desc: string; at: string }) => ({
    source: "youtube_video", title: v.title, snippet: v.desc.slice(0, 220), url: `https://www.youtube.com/watch?v=${v.id}`, posted_at: v.at,
    metric: { views: Number(stats.get(v.id)?.viewCount ?? 0), likes: Number(stats.get(v.id)?.likeCount ?? 0), comments: Number(stats.get(v.id)?.commentCount ?? 0) },
  }));
  const top = [...vids].sort((a: { id: string }, c: { id: string }) => Number(stats.get(c.id)?.viewCount ?? 0) - Number(stats.get(a.id)?.viewCount ?? 0)).slice(0, 3);
  for (const v of top as Array<{ id: string; title: string }>) {
    try {
      const c = await yt("commentThreads", { part: "snippet", videoId: v.id, maxResults: 20, order: "relevance", textFormat: "plainText" });
      // deno-lint-ignore no-explicit-any
      for (const t of (c.items ?? []) as any[]) {
        const sn = t.snippet.topLevelComment.snippet;
        items.push({ source: "youtube_comment", title: v.title, snippet: strip(sn.textDisplay).slice(0, 300), url: `https://www.youtube.com/watch?v=${v.id}&lc=${t.snippet.topLevelComment.id}`, posted_at: sn.publishedAt, metric: { likes: sn.likeCount } });
      }
    } catch (_) { /* 댓글이 막힌 영상은 건너뜀 */ }
  }
  return items;
}

// ---------- 네이버 검색 (NAVER API HUB) ----------
async function naverSearch(kind: "blog" | "news" | "cafearticle", q: string, start = 1) {
  const id = env("NAVERSEARCH_CLIENT_ID") || env("NAVERHUB_CLIENT_ID");
  const sec = env("NAVERSEARCH_CLIENT_SECRET") || env("NAVERHUB_CLIENT_SECRET");
  // 날짜 내림차순으로 100건씩 넘기며 수집 기간 시작일을 지날 때까지 가져온다 (start는 최대 1000)
  const r = await fetch(`https://naverapihub.apigw.ntruss.com/search/v1/${kind}?query=${encodeURIComponent(q)}&display=100&start=${start}&sort=date`, {
    headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": sec },
  });
  if (!r.ok) throw new Error(`네이버 검색(${kind}) ${r.status}: ${(await r.text()).slice(0, 120)}`);
  // deno-lint-ignore no-explicit-any
  return ((await r.json()).items ?? []) as any[];
}
// since~until(ISO) 사이에 발행된 글만 모은다. 카페글은 API가 작성일을 주지 않아 posted_at=null로 두고 호출부에서 기준월을 붙인다.
async function collectNaver(b: Brand, errs: string[], since: number, until: number): Promise<Item[]> {
  const out: Item[] = [];
  const jobs: Array<["blog" | "news" | "cafearticle", string, string, number]> = [["blog", "blog", `${b.name} 후기`, 500], ["cafearticle", "cafe", `${b.name} 후기`, 100], ["news", "news", b.name, 500]];
  for (const [kind, source, q, maxItems] of jobs) {
    try {
      let done = false;
      for (let start = 1; start <= maxItems && !done; start += 100) {
        const page = await naverSearch(kind, q, start);
        if (page.length < 100) done = true;
        for (const it of page) {
          const title = strip(it.title), snippet = strip(it.description);
          let at: string | null = null;
          if (it.postdate && /^\d{8}$/.test(it.postdate)) at = `${it.postdate.slice(0, 4)}-${it.postdate.slice(4, 6)}-${it.postdate.slice(6, 8)}T12:00:00+09:00`;
          else if (it.pubDate) { const d = new Date(it.pubDate); if (!isNaN(d.getTime())) at = d.toISOString(); }
          if (at) {
            const t = new Date(at).getTime();
            if (t < since) { done = true; continue; } // 날짜 내림차순이라 이후는 모두 기간 밖
            if (t >= until) continue;
          }
          if (!matches(b, title + " " + snippet)) continue;
          out.push({ source, title, snippet: snippet.slice(0, 220), url: String(it.originallink || it.link), posted_at: at, metric: null });
        }
      }
    } catch (e) { errs.push(`${b.name}/${source}: ${(e as Error).message}`); if (/ 40[134] /.test((e as Error).message)) break; }
  }
  return out;
}

// ---------- AI 요약 ----------
async function summarize(b: Brand, items: Array<{ source: string; title: string; snippet: string }>, ym: string) {
  const list = items.slice(0, 120).map((x, i) => `[${i + 1}](${x.source}) ${x.title.slice(0, 80)} / ${x.snippet.slice(0, 160)}`).join("\n");
  const prompt = `브랜드: ${b.name} (업태: ${b.segment ?? "미확인"})
아래는 ${ym}에 발행된 고객 후기·언급 ${items.length}건이다.
${list}

규칙:
1) 위 목록에 있는 내용만 근거로 쓴다. 추측하거나 없는 내용을 만들지 않는다.
2) positives / negatives: 반복해서 언급된 주제만. count는 그 주제를 언급한 항목 수(정수, 전체 건수 이하). example은 원문을 40자 이내로 바꿔 쓴 표현이며 원문을 그대로 인용하거나 개인정보를 넣지 않는다.
3) features: 자주 언급되는 메뉴·가격대·분위기·서비스 특징을 최대 6개 (짧은 문장).
4) flags: 위생·가격 인상·폐점·논란 등 주의 신호. 없으면 빈 배열.
5) 표본이 8건 미만이면 headline에 "표본 부족"을 넣는다. headline은 한 문장.
출력은 JSON만(설명·코드블록 금지):
{"headline":"","positives":[{"theme":"","count":0,"example":""}],"negatives":[{"theme":"","count":0,"example":""}],"features":[""],"flags":[""]}`;
  const SYS = "너는 외식 시장 리서치 분석가다. 주어진 자료만 근거로 간결하고 정확하게 요약하고, 지정한 JSON 형식으로만 답한다.";
  // 키가 있는 쪽을 쓴다: Gemini(무료 등급 가능) 우선, 없으면 Anthropic
  const { text, model } = env("GEMINI_API_KEY") ? await callGemini(SYS, prompt) : await callClaude(SYS, prompt);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("요약 응답에서 JSON을 찾지 못했습니다.");
  return { out: JSON.parse(m[0]), model };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function callClaude(system: string, prompt: string) {
  const model = env("DEMAND_AI_MODEL") || "claude-sonnet-5-5";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1800, system, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).replaceAll(env("ANTHROPIC_API_KEY"), "***").slice(0, 160)}`);
  return { text: ((await r.json()).content ?? []).map((c: { text?: string }) => c.text ?? "").join(""), model };
}
// Gemini: 모델 이름이 바뀌거나 중단돼도 이어서 쓰도록 후보를 차례로 시도하고, 무료 등급의 호출 한도(429)에는 잠시 기다렸다 재시도한다
async function callGemini(system: string, prompt: string) {
  const key = env("GEMINI_API_KEY");
  const models = [env("GEMINI_MODEL"), "gemini-2.5-flash", "gemini-flash-latest"].filter((x, i, a) => x && a.indexOf(x) === i);
  let lastErr = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 4096 },
        }),
      });
      if (r.ok) {
        const j = await r.json();
        const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
        if (!text) throw new Error(`Gemini 응답이 비어 있습니다(${j.candidates?.[0]?.finishReason ?? j.promptFeedback?.blockReason ?? "알 수 없음"}).`);
        return { text, model };
      }
      const body = (await r.text()).replaceAll(key, "***");
      lastErr = `Gemini(${model}) ${r.status}: ${body.slice(0, 160)}`;
      if (r.status === 404) break; // 이 모델은 없음 → 다음 후보
      if (r.status === 429 || r.status >= 500) {
        if (/PerDay|per day|daily/i.test(body)) throw new Error(lastErr); // 일일 한도는 기다려도 소용없음
        await sleep(attempt === 0 ? 8000 : 15000); continue;
      }
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr || "Gemini 호출 실패");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const cron = req.headers.get("x-cron-secret");
    let isCron = false;
    if (cron) {
      const { data: sec } = await createClient(SUPABASE_URL, SERVICE_KEY).from("demand_private").select("value").eq("key", "cron_secret").maybeSingle();
      isCron = !!sec && sec.value === cron;
    }
    if (!isCron) {
      const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
      const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
      const { data: { user: u } } = await user.auth.getUser(jwt);
      if (!u) return json({ error: "로그인이 필요합니다." }, 401);
      const { data: prof } = await user.from("ot_profiles").select("role").eq("user_id", u.id).maybeSingle();
      if (!prof || prof.role !== "planner") return json({ error: "기획자 계정만 실행할 수 있습니다." }, 403);
    }
    const body = await req.json().catch(() => ({}));
    const mode: string = body.mode ?? "all";
    const t0 = Date.now(); // 함수 실행 제한(약 150초) 안에서 요약을 끊어서 이어 가기 위한 시작 시각
    const hasYt = !!env("YOUTUBE_API_KEY"), hasAi = !!(env("GEMINI_API_KEY") || env("ANTHROPIC_API_KEY"));
    const useGemini = !!env("GEMINI_API_KEY");
    const hasNaver = !!(env("NAVERSEARCH_CLIENT_ID") || env("NAVERHUB_CLIENT_ID"));
    if (!hasYt && !hasNaver && (mode === "collect" || mode === "all")) return json({ error: "수집할 출처 키(YOUTUBE_API_KEY 또는 네이버 검색)가 등록되지 않았습니다." }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: run } = await admin.from("demand_runs").insert({ kind: "voice", status: "running" }).select().single();
    const finish = (status: string, message: string) =>
      admin.from("demand_runs").update({ status, message, finished_at: new Date().toISOString() }).eq("id", run?.id ?? -1);
    try {
      let q = admin.from("demand_brands").select("id,name,kind,segment,aliases").neq("status", "excluded").order("id");
      if (body.brand_id) q = q.eq("id", body.brand_id);
      const brands = ((await q).data ?? []) as Brand[];
      // ---- 대상 기간: body.ym(YYYY-MM)이 있으면 그 달만, 없으면 지난달 + 이번 달(진행분) ----
      const nowYm = kstYm(), prevYm = addMonths(nowYm, -1);
      const target = typeof body.ym === "string" && /^\d{4}-\d{2}$/.test(body.ym) ? body.ym : null;
      const months = target ? [target] : [prevYm, nowYm];
      const sinceMs = new Date(monthStart(months[0])).getTime();
      const untilMs = Math.min(new Date(monthStart(addMonths(months[months.length - 1], 1))).getTime(), Date.now() + 1000);
      // 카페글은 작성일이 없어 '수집 시점 최신글'을 기준월에 귀속(월초 5일 이내 실행이면 지난달)
      const kstDay = new Date(Date.now() + 9 * 3600 * 1000).getUTCDate();
      const cafeYm = target ?? (kstDay <= 5 ? prevYm : nowYm);
      const errs: string[] = [];
      let collected = 0, summarized = 0;

      if (mode === "collect" || mode === "all") {
        await pool(brands, 3, async (b) => {
          const items: Item[] = [];
          if (hasYt) { try { items.push(...await collectYoutube(b, months)); } catch (e) { errs.push(`${b.name}/youtube: ${(e as Error).message}`); } }
          if (hasNaver) items.push(...await collectNaver(b, errs, sinceMs, untilMs));
          const seen = new Set<string>();
          // 발행월로 귀속, 대상 기간 밖은 버림
          const rows = items.filter((x) => x.url && !seen.has(x.source + x.url) && seen.add(x.source + x.url))
            .map((x) => ({ brand_id: b.id, ym: x.posted_at ? monthOf(x.posted_at) : cafeYm, ...x }))
            .filter((x) => months.includes(x.ym));
          if (rows.length) { ck(await admin.from("demand_voice_raw").upsert(rows, { onConflict: "brand_id,source,url" })); collected += rows.length; }
        });
      }

      let remaining = 0;
      if ((mode === "summarize" || mode === "all") && hasAi) {
        // 최근 6시간 안에 이미 만든 요약은 건너뛴다(끊어서 이어 호출할 때 중복 방지). body.force=true면 전부 다시 만든다.
        const { data: done } = await admin.from("demand_voice_summary").select("brand_id,ym,created_at").in("ym", months);
        const fresh = new Set((done ?? []).filter((r) => Date.now() - new Date(r.created_at).getTime() < 6 * 3600 * 1000).map((r) => `${r.brand_id}|${r.ym}`));
        const tasks = brands.flatMap((b) => months.map((ym) => ({ b, ym }))).filter((t) => body.force || !fresh.has(`${t.b.id}|${t.ym}`));
        // 무료 Gemini는 분당 호출 수가 적어 하나씩 간격을 두고, 시간이 다 되면 남은 것은 다음 호출로 넘긴다
        await pool(tasks, useGemini ? 1 : 3, async ({ b, ym }) => {
          if (Date.now() - t0 > 105000) { remaining++; return; }
          const { data: raw } = await admin.from("demand_voice_raw").select("source,title,snippet").eq("brand_id", b.id).eq("ym", ym).limit(300);
          const items = raw ?? [];
          if (items.length < 3) return; // 표본이 너무 적으면 요약하지 않음(화면에는 원문 건수만 표시)
          if (useGemini) await sleep(4500);
          const sources: Record<string, number> = {};
          for (const x of items) sources[x.source] = (sources[x.source] ?? 0) + 1;
          try {
            const { out, model } = await summarize(b, items, ym);
            ck(await admin.from("demand_voice_summary").upsert({
              brand_id: b.id, ym, n_items: items.length, sources, headline: String(out.headline ?? ""), model,
              positives: out.positives ?? [], negatives: out.negatives ?? [], features: out.features ?? [], flags: out.flags ?? [], created_at: new Date().toISOString(),
            }));
            summarized++;
          } catch (e) { errs.push(`${b.name}/${ym}/요약: ${(e as Error).message}`); }
        });
      } else if ((mode === "summarize" || mode === "all") && !hasAi) {
        errs.push("요약 키가 없어 요약은 건너뛰었습니다.");
      }

      const summary = `${months.join("·")} 발행분 원문 ${collected}건 수집 · 브랜드×월 ${summarized}건 요약${remaining ? ` · 남은 요약 ${remaining}건(다시 실행하면 이어서 진행)` : ""}${errs.length ? " · 확인 필요 " + errs.length + "건: " + errs.slice(0, 2).join(" | ") : ""}`;
      await finish(errs.length && !collected && !summarized ? "error" : "ok", summary.slice(0, 300));
      return json({ ok: true, summary, errors: errs, remaining });
    } catch (e) {
      await finish("error", String((e as Error).message).slice(0, 300));
      return json({ error: (e as Error).message }, 500);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
