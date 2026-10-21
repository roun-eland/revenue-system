// 로운 수요 모니터링 — 검색 지표 수집 (Supabase Edge Function, Deno)
// 호출: 화면의 "지금 수집" 버튼(기획자 로그인 JWT) 또는 예약 실행(x-cron-secret 헤더 = DEMAND_CRON_SECRET)
// 필요한 Secrets: NAVERAD_CUSTOMER_ID, NAVERAD_ACCESS_LICENSE, NAVERAD_SECRET_KEY, NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
//   (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 자동 제공)
// 하는 일:
//   1) 네이버 검색광고 API 키워드 도구 → 월 검색수(PC·모바일)·경쟁정도 스냅샷을 demand_search_monthly에 적재, 시장/우리 키워드는 연관검색어도 demand_related에 적재
//   2) 네이버 데이터랩 검색어트렌드 → 최근 24개월 월별 상대지수를 demand_trend에 적재 (과거 추이 추정용)
// 주의: 검색광고 API는 과거 월별 값을 주지 않으므로 이 함수를 매월 돌려 스냅샷을 쌓는다. 응답 필드 이름은 실제 키로 첫 호출할 때 확인한다.

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

// 검색광고 API 서명: base64(HMAC-SHA256(secret, `${timestamp}.${method}.${uri}`))
async function adSign(ts: string, method: string, uri: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${method}.${uri}`));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function keywordTool(hints: string[]) {
  const uri = "/keywordstool";
  const ts = String(Date.now());
  const res = await fetch(`https://api.searchad.naver.com${uri}?hintKeywords=${encodeURIComponent(hints.join(","))}&showDetail=1`, {
    headers: {
      "X-Timestamp": ts,
      "X-API-KEY": Deno.env.get("NAVERAD_ACCESS_LICENSE")!,
      "X-Customer": Deno.env.get("NAVERAD_CUSTOMER_ID")!,
      "X-Signature": await adSign(ts, "GET", uri, Deno.env.get("NAVERAD_SECRET_KEY")!),
    },
  });
  if (!res.ok) throw new Error(`검색광고 API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.keywordList ?? []) as Array<Record<string, unknown>>;
}
// "< 10"처럼 가려진 값은 null
const cnt = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? parseInt(v) : null);
const nospace = (s: string) => s.replace(/\s+/g, "");

async function dataLab(keywords: Array<{ id: number; keyword: string }>, start: string, end: string) {
  const res = await fetch("https://openapi.naver.com/v1/datalab/search", {
    method: "POST",
    headers: {
      "X-Naver-Client-Id": Deno.env.get("NAVER_CLIENT_ID")!,
      "X-Naver-Client-Secret": Deno.env.get("NAVER_CLIENT_SECRET")!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      startDate: start, endDate: end, timeUnit: "month",
      keywordGroups: keywords.map((k) => ({ groupName: k.keyword, keywords: [k.keyword] })),
    }),
  });
  if (!res.ok) throw new Error(`데이터랩 API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).results as Array<{ title: string; data: Array<{ period: string; ratio: number }> }>;
}

function kstYm(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // ---- 권한: 기획자 JWT 또는 예약 실행 비밀값 ----
    const cron = req.headers.get("x-cron-secret");
    if (!(cron && cron === Deno.env.get("DEMAND_CRON_SECRET"))) {
      const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
      const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
      const { data: { user: u } } = await user.auth.getUser(jwt);
      if (!u) return json({ error: "로그인이 필요합니다." }, 401);
      const { data: prof } = await user.from("ot_profiles").select("role").eq("user_id", u.id).maybeSingle();
      if (!prof || prof.role !== "planner") return json({ error: "기획자 계정만 실행할 수 있습니다." }, 403);
    }
    for (const n of ["NAVERAD_CUSTOMER_ID", "NAVERAD_ACCESS_LICENSE", "NAVERAD_SECRET_KEY", "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET"]) {
      if (!Deno.env.get(n)) return json({ error: `서버 설정에 ${n} 키가 아직 등록되지 않았습니다.` }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: run } = await admin.from("demand_runs").insert({ kind: "search", status: "running" }).select().single();
    const finish = (status: string, message: string) =>
      admin.from("demand_runs").update({ status, message, finished_at: new Date().toISOString() }).eq("id", run!.id);
    try {
      const { data: kws } = await admin.from("demand_keywords").select("id,keyword,grp").eq("active", true).order("id");
      const keywords = (kws ?? []) as Array<{ id: number; keyword: string; grp: string }>;
      const ym = kstYm();
      let volRows = 0, relRows = 0, trendRows = 0;

      // 1-a) 시장·우리 키워드: 하나씩 조회해 연관검색어를 그 키워드에 귀속
      for (const k of keywords.filter((x) => x.grp === "market" || x.grp === "own")) {
        const list = await keywordTool([nospace(k.keyword)]);
        const self = list.find((r) => String(r.relKeyword) === nospace(k.keyword));
        if (self) {
          const pc = cnt(self.monthlyPcQcCnt), mobile = cnt(self.monthlyMobileQcCnt);
          await admin.from("demand_search_monthly").upsert({ keyword_id: k.id, ym, pc, mobile, total: pc == null && mobile == null ? null : (pc ?? 0) + (mobile ?? 0), comp: (self.compIdx as string) ?? null });
          volRows++;
        }
        const rel = list
          .filter((r) => String(r.relKeyword) !== nospace(k.keyword))
          .map((r) => { const pc = cnt(r.monthlyPcQcCnt), mobile = cnt(r.monthlyMobileQcCnt); return { r, pc, mobile, total: (pc ?? 0) + (mobile ?? 0) }; })
          .sort((a, b) => b.total - a.total).slice(0, 30)
          .map((x, i) => ({ keyword_id: k.id, ym, related: String(x.r.relKeyword), pc: x.pc, mobile: x.mobile, total: x.total, comp: (x.r.compIdx as string) ?? null, rank: i + 1 }));
        if (rel.length) { await admin.from("demand_related").upsert(rel); relRows += rel.length; }
        await sleep(400);
      }
      // 1-b) 나머지(경쟁사·니즈): 5개씩 묶어 월 검색수만
      const rest = keywords.filter((x) => x.grp === "competitor" || x.grp === "need");
      for (let i = 0; i < rest.length; i += 5) {
        const chunk = rest.slice(i, i + 5);
        const list = await keywordTool(chunk.map((k) => nospace(k.keyword)));
        const byName = new Map(list.map((r) => [String(r.relKeyword), r]));
        for (const k of chunk) {
          const r = byName.get(nospace(k.keyword));
          if (!r) continue;
          const pc = cnt(r.monthlyPcQcCnt), mobile = cnt(r.monthlyMobileQcCnt);
          await admin.from("demand_search_monthly").upsert({ keyword_id: k.id, ym, pc, mobile, total: pc == null && mobile == null ? null : (pc ?? 0) + (mobile ?? 0), comp: (r.compIdx as string) ?? null });
          volRows++;
        }
        await sleep(400);
      }

      // 2) 데이터랩: 최근 24개월 월별 상대지수 (한 번에 5개 키워드 그룹)
      const end = new Date(); const start = new Date(end.getFullYear(), end.getMonth() - 23, 1);
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      for (let i = 0; i < keywords.length; i += 5) {
        const chunk = keywords.slice(i, i + 5);
        const results = await dataLab(chunk.map((k) => ({ id: k.id, keyword: k.keyword })), fmt(start), fmt(end));
        for (const r of results) {
          const k = chunk.find((x) => x.keyword === r.title);
          if (!k) continue;
          const rows = r.data.map((d) => ({ keyword_id: k.id, period: d.period, ratio: d.ratio }));
          if (rows.length) { await admin.from("demand_trend").upsert(rows); trendRows += rows.length; }
        }
        await sleep(300);
      }
      const summary = `월 검색수 ${volRows}개 · 연관어 ${relRows}건 · 추이 ${trendRows}점 (${ym})`;
      await finish("ok", summary);
      return json({ ok: true, summary });
    } catch (e) {
      await finish("error", String((e as Error).message).slice(0, 300));
      return json({ error: (e as Error).message }, 500);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
