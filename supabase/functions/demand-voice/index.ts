// 로운 수요 모니터링 — 3단계 고객 반응 수집·요약 (Supabase Edge Function, Deno)
// 호출: 화면의 "지금 수집" 버튼(기획자 JWT) 또는 예약 실행(x-cron-secret = DB demand_private.cron_secret)
// body: { mode?: "collect" | "summarize" | "all"(기본), brand_id?: number }
// 필요한 Secrets(있는 출처만 사용, 없으면 그 출처는 건너뜀):
//   YOUTUBE_API_KEY                      유튜브 영상·댓글
//   NAVERHUB_CLIENT_ID / _SECRET         네이버 블로그·뉴스·카페 검색 (NAVER API HUB에 '검색' API 등록 필요)
//     (검색 전용 Application을 따로 만들었다면 NAVERSEARCH_CLIENT_ID / _SECRET 이 우선)
//   ANTHROPIC_API_KEY                    요약 (선택: DEMAND_AI_MODEL 로 모델 지정)
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
async function collectYoutube(b: Brand): Promise<Item[]> {
  const after = new Date(Date.now() - 90 * 864e5).toISOString();
  const s = await yt("search", { part: "snippet", type: "video", q: `${b.name} 후기`, maxResults: 25, order: "relevance", publishedAfter: after, regionCode: "KR", relevanceLanguage: "ko" });
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
async function naverSearch(kind: "blog" | "news" | "cafearticle", q: string) {
  const id = env("NAVERSEARCH_CLIENT_ID") || env("NAVERHUB_CLIENT_ID");
  const sec = env("NAVERSEARCH_CLIENT_SECRET") || env("NAVERHUB_CLIENT_SECRET");
  const sort = kind === "news" ? "date" : "sim";
  const r = await fetch(`https://naverapihub.apigw.ntruss.com/search/v1/${kind}?query=${encodeURIComponent(q)}&display=50&sort=${sort}`, {
    headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": sec },
  });
  if (!r.ok) throw new Error(`네이버 검색(${kind}) ${r.status}: ${(await r.text()).slice(0, 120)}`);
  // deno-lint-ignore no-explicit-any
  return ((await r.json()).items ?? []) as any[];
}
async function collectNaver(b: Brand, errs: string[]): Promise<Item[]> {
  const out: Item[] = [];
  const cutoff = Date.now() - 90 * 864e5;
  const jobs: Array<["blog" | "news" | "cafearticle", string, string]> = [["blog", "blog", `${b.name} 후기`], ["cafearticle", "cafe", `${b.name} 후기`], ["news", "news", b.name]];
  for (const [kind, source, q] of jobs) {
    try {
      for (const it of await naverSearch(kind, q)) {
        const title = strip(it.title), snippet = strip(it.description);
        if (!matches(b, title + " " + snippet)) continue;
        let at: string | null = null;
        if (it.postdate && /^\d{8}$/.test(it.postdate)) at = `${it.postdate.slice(0, 4)}-${it.postdate.slice(4, 6)}-${it.postdate.slice(6, 8)}T00:00:00+09:00`;
        else if (it.pubDate) { const d = new Date(it.pubDate); if (!isNaN(d.getTime())) at = d.toISOString(); }
        if (at && new Date(at).getTime() < cutoff) continue;
        out.push({ source, title, snippet: snippet.slice(0, 220), url: String(it.originallink || it.link), posted_at: at, metric: null });
      }
    } catch (e) { errs.push(`${b.name}/${source}: ${(e as Error).message}`); if (/ 40[134] /.test((e as Error).message)) break; }
  }
  return out;
}

// ---------- AI 요약 ----------
async function summarize(b: Brand, items: Array<{ source: string; title: string; snippet: string }>) {
  const list = items.slice(0, 120).map((x, i) => `[${i + 1}](${x.source}) ${x.title.slice(0, 80)} / ${x.snippet.slice(0, 160)}`).join("\n");
  const prompt = `브랜드: ${b.name} (업태: ${b.segment ?? "미확인"})
아래는 최근 90일간 수집한 고객 후기·언급 ${items.length}건이다.
${list}

규칙:
1) 위 목록에 있는 내용만 근거로 쓴다. 추측하거나 없는 내용을 만들지 않는다.
2) positives / negatives: 반복해서 언급된 주제만. count는 그 주제를 언급한 항목 수(정수, 전체 건수 이하). example은 원문을 40자 이내로 바꿔 쓴 표현이며 원문을 그대로 인용하거나 개인정보를 넣지 않는다.
3) features: 자주 언급되는 메뉴·가격대·분위기·서비스 특징을 최대 6개 (짧은 문장).
4) flags: 위생·가격 인상·폐점·논란 등 주의 신호. 없으면 빈 배열.
5) 표본이 8건 미만이면 headline에 "표본 부족"을 넣는다. headline은 한 문장.
출력은 JSON만(설명·코드블록 금지):
{"headline":"","positives":[{"theme":"","count":0,"example":""}],"negatives":[{"theme":"","count":0,"example":""}],"features":[""],"flags":[""]}`;
  const model = env("DEMAND_AI_MODEL") || "claude-sonnet-5-5";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1800, system: "너는 외식 시장 리서치 분석가다. 주어진 자료만 근거로 간결하고 정확하게 요약하고, 지정한 JSON 형식으로만 답한다.", messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).replaceAll(env("ANTHROPIC_API_KEY"), "***").slice(0, 160)}`);
  const text = ((await r.json()).content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("요약 응답에서 JSON을 찾지 못했습니다.");
  return { out: JSON.parse(m[0]), model };
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
    const hasYt = !!env("YOUTUBE_API_KEY"), hasAi = !!env("ANTHROPIC_API_KEY");
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
      const ym = kstYm();
      const errs: string[] = [];
      let collected = 0, summarized = 0;

      if (mode === "collect" || mode === "all") {
        await pool(brands, 3, async (b) => {
          const items: Item[] = [];
          if (hasYt) { try { items.push(...await collectYoutube(b)); } catch (e) { errs.push(`${b.name}/youtube: ${(e as Error).message}`); } }
          if (hasNaver) items.push(...await collectNaver(b, errs));
          const seen = new Set<string>();
          const rows = items.filter((x) => x.url && !seen.has(x.source + x.url) && seen.add(x.source + x.url)).map((x) => ({ brand_id: b.id, ym, ...x }));
          if (rows.length) { ck(await admin.from("demand_voice_raw").upsert(rows, { onConflict: "brand_id,source,url" })); collected += rows.length; }
        });
      }

      if ((mode === "summarize" || mode === "all") && hasAi) {
        await pool(brands, 3, async (b) => {
          const { data: raw } = await admin.from("demand_voice_raw").select("source,title,snippet").eq("brand_id", b.id).eq("ym", ym).limit(300);
          const items = raw ?? [];
          const sources: Record<string, number> = {};
          for (const x of items) sources[x.source] = (sources[x.source] ?? 0) + 1;
          if (!items.length) { errs.push(`${b.name}: 수집된 원문이 없어 요약하지 않았습니다.`); return; }
          try {
            const { out, model } = await summarize(b, items);
            ck(await admin.from("demand_voice_summary").upsert({
              brand_id: b.id, ym, n_items: items.length, sources, headline: String(out.headline ?? ""), model,
              positives: out.positives ?? [], negatives: out.negatives ?? [], features: out.features ?? [], flags: out.flags ?? [], created_at: new Date().toISOString(),
            }));
            summarized++;
          } catch (e) { errs.push(`${b.name}/요약: ${(e as Error).message}`); }
        });
      } else if ((mode === "summarize" || mode === "all") && !hasAi) {
        errs.push("ANTHROPIC_API_KEY가 없어 요약은 건너뛰었습니다.");
      }

      const summary = `원문 ${collected}건 수집 · ${summarized}개 브랜드 요약 (${ym})${errs.length ? " · 확인 필요 " + errs.length + "건: " + errs.slice(0, 2).join(" | ") : ""}`;
      await finish(errs.length && !collected && !summarized ? "error" : "ok", summary.slice(0, 300));
      return json({ ok: true, summary, errors: errs });
    } catch (e) {
      await finish("error", String((e as Error).message).slice(0, 300));
      return json({ error: (e as Error).message }, 500);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
