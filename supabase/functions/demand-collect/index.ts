// 로운 수요 모니터링 — 검색 지표 수집 (Supabase Edge Function, Deno)
// 호출: 화면의 "지금 수집" 버튼(기획자 로그인 JWT) 또는 예약 실행(x-cron-secret 헤더 = DEMAND_CRON_SECRET)
// 필요한 Secrets: NAVERAD_CUSTOMER_ID, NAVERAD_ACCESS_LICENSE, NAVERAD_SECRET_KEY (검색광고 API),
//   NAVERHUB_CLIENT_ID, NAVERHUB_CLIENT_SECRET (NAVER API HUB 검색어 트렌드 — 네이버 개발자센터 데이터랩은 신규 신청 종료로 HUB로 이관됨)
//   (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 자동 제공)
// 하는 일:
//   1) 네이버 검색광고 API 키워드 도구 → 월 검색수(PC·모바일)·경쟁정도 스냅샷을 demand_search_monthly에 적재, 시장/우리 키워드는 연관검색어도 demand_related에 적재
//   2) NAVER API HUB 검색어 트렌드 → 최근 24개월 월별 상대지수를 demand_trend에 적재 (과거 추이 추정용)
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
// 키를 붙여넣을 때 끼는 앞뒤 공백·줄바꿈 제거
const env = (n: string) => (Deno.env.get(n) ?? "").trim();
// upsert 실패를 조용히 넘기지 않고 실행 기록(demand_runs)에 남기기 위해 오류를 던진다
// deno-lint-ignore no-explicit-any
const ck = (r: any) => { if (r?.error) throw new Error(`DB 저장 실패: ${r.error.message}`); };

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
      "X-API-KEY": env("NAVERAD_ACCESS_LICENSE"),
      "X-Customer": env("NAVERAD_CUSTOMER_ID"),
      "X-Signature": await adSign(ts, "GET", uri, env("NAVERAD_SECRET_KEY")),
    },
  });
  if (!res.ok) {
    // 키 값은 노출하지 않고 길이·형태만 알려 입력 실수를 가려낸다 (고객ID 숫자, 라이선스 64자, 비밀키 44자 안팎이 정상)
    const c = env("NAVERAD_CUSTOMER_ID"), l = env("NAVERAD_ACCESS_LICENSE"), k = env("NAVERAD_SECRET_KEY");
    const diag = `[진단 고객ID ${c.length}자${/^\d+$/.test(c) ? "·숫자" : "·숫자아님"} / 라이선스 ${l.length}자 / 비밀키 ${k.length}자]`;
    // 네이버 오류 본문에는 액세스 라이선스가 그대로 들어 있어 화면·DB에 남기지 않도록 가린다
    const body = (await res.text()).replace(/api-key:\s*\S+/g, "api-key: ***").slice(0, 120);
    throw new Error(`검색광고 API ${res.status} ${diag}: ${body}`);
  }
  const data = await res.json();
  return (data.keywordList ?? []) as Array<Record<string, unknown>>;
}
// "< 10"처럼 가려진 값은 null
const cnt = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? parseInt(v) : null);
const nospace = (s: string) => s.replace(/\s+/g, "");

async function dataLab(keywords: Array<{ id: number; keyword: string }>, start: string, end: string) {
  const res = await fetch("https://naverapihub.apigw.ntruss.com/search-trend/v1/search", {
    method: "POST",
    headers: {
      "X-NCP-APIGW-API-KEY-ID": env("NAVERHUB_CLIENT_ID"),
      "X-NCP-APIGW-API-KEY": env("NAVERHUB_CLIENT_SECRET"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      startDate: start, endDate: end, timeUnit: "month",
      keywordGroups: keywords.map((k) => ({ groupName: k.keyword, keywords: [k.keyword] })),
    }),
  });
  if (!res.ok) throw new Error(`검색어 트렌드(HUB) API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).results as Array<{ title: string; data: Array<{ period: string; ratio: number }> }>;
}

function kstYm(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  // 검색광고 월 검색수는 직전 한 달 기준 값이라, 월초(1~5일) 수집분은 지난달로 표기한다 (매월 1일 자동 수집 → 전달 리포트와 맞물림)
  if (k.getUTCDate() <= 5) k.setUTCMonth(k.getUTCMonth() - 1, 1);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // ---- 권한: 기획자 JWT 또는 예약 실행 비밀값 ----
    // 예약 실행(pg_cron)은 DB(demand_private)에 보관된 비밀값과 일치할 때만 통과. 환경 변수 DEMAND_CRON_SECRET도 계속 허용.
    const cron = req.headers.get("x-cron-secret");
    let isCron = false;
    if (cron) {
      if (cron === Deno.env.get("DEMAND_CRON_SECRET")) isCron = true;
      else {
        const { data: sec } = await createClient(SUPABASE_URL, SERVICE_KEY).from("demand_private").select("value").eq("key", "cron_secret").maybeSingle();
        isCron = !!sec && sec.value === cron;
      }
    }
    if (!isCron) {
      const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
      const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
      const { data: { user: u } } = await user.auth.getUser(jwt);
      if (!u) return json({ error: "로그인이 필요합니다." }, 401);
      const { data: prof } = await user.from("ot_profiles").select("role").eq("user_id", u.id).maybeSingle();
      if (!prof || prof.role !== "planner") return json({ error: "기획자 계정만 실행할 수 있습니다." }, 403);
    }
    for (const n of ["NAVERAD_CUSTOMER_ID", "NAVERAD_ACCESS_LICENSE", "NAVERAD_SECRET_KEY", "NAVERHUB_CLIENT_ID", "NAVERHUB_CLIENT_SECRET"]) {
      if (!env(n)) return json({ error: `서버 설정에 ${n} 키가 아직 등록되지 않았습니다.` }, 400);
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
          ck(await admin.from("demand_search_monthly").upsert({ keyword_id: k.id, ym, pc, mobile, total: pc == null && mobile == null ? null : (pc ?? 0) + (mobile ?? 0), comp: (self.compIdx as string) ?? null }));
          volRows++;
        }
        const rel = list
          .filter((r) => String(r.relKeyword) !== nospace(k.keyword))
          .map((r) => { const pc = cnt(r.monthlyPcQcCnt), mobile = cnt(r.monthlyMobileQcCnt); return { r, pc, mobile, total: (pc ?? 0) + (mobile ?? 0) }; })
          .sort((a, b) => b.total - a.total).slice(0, 30)
          .map((x, i) => ({ keyword_id: k.id, ym, related: String(x.r.relKeyword), pc: x.pc, mobile: x.mobile, total: x.total, comp: (x.r.compIdx as string) ?? null, rank: i + 1 }));
        if (rel.length) { ck(await admin.from("demand_related").upsert(rel)); relRows += rel.length; }
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
          ck(await admin.from("demand_search_monthly").upsert({ keyword_id: k.id, ym, pc, mobile, total: pc == null && mobile == null ? null : (pc ?? 0) + (mobile ?? 0), comp: (r.compIdx as string) ?? null }));
          volRows++;
        }
        await sleep(400);
      }

      // 2) 검색어 트렌드(HUB): 최근 24개월 월별 상대지수 (한 번에 5개 키워드 그룹)
      const end = new Date(); const start = new Date(end.getFullYear(), end.getMonth() - 23, 1);
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dim = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
      const elapsed = end.getDate() - 1; // 데이터랩은 어제까지의 값
      const curPeriod = `${fmt(end).slice(0, 7)}-01`;
      for (let i = 0; i < keywords.length; i += 5) {
        const chunk = keywords.slice(i, i + 5);
        const results = await dataLab(chunk.map((k) => ({ id: k.id, keyword: k.keyword })), fmt(start), fmt(end));
        for (const r of results) {
          const k = chunk.find((x) => x.keyword === r.title);
          if (!k) continue;
          // 이번 달은 아직 진행 중이라 데이터랩 지수가 지난 날짜만큼만 쌓여 있다 → 한 달치로 환산해 저장 (그대로 두면 이번 달이 실제보다 낮게 잡혀 과거 추정이 부풀려진다)
          const rows = r.data.map((d) => ({ keyword_id: k.id, period: d.period, ratio: d.period === curPeriod && elapsed >= 1 && elapsed < dim ? d.ratio * dim / elapsed : d.ratio }));
          if (rows.length) { ck(await admin.from("demand_trend").upsert(rows)); trendRows += rows.length; }
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
