// 로운 수요 모니터링 — 2단계 경쟁사 점포 수 (Supabase Edge Function, Deno)
// 공공데이터포털(apis.data.go.kr) 두 곳을 조합한다. 인증: DB demand_private.cron_secret(예약) 또는 기획자 JWT.
//   ① 공정위 정보공개서 기반 브랜드 점포 수(가맹점·직영점, 지역별)  — 브랜드관리번호가 있는 브랜드만
//        브랜드 목록  : /1130000/FftcBrandRlsInfo2_Service/getBrandinfo          (jngBizCrtraYr → brandMnno, brandNm …)
//        점포 수      : /1130000/FftcBrandFrcsDropInfo3_Service/getbrandFrcsDmsstus2 (jngBizCrtraYr, brandMnno → areaNm, frcsCnt, dmsCnt)
//   ② 소상공인 상가(상권)정보(점포 목록을 받아 상호명으로 거름) — 번호가 없는 브랜드 보완 (아직 미구현)
// body.mode: "resolve" = 브랜드 목록에서 우리 브랜드 이름을 찾아 후보를 돌려준다(저장 안 함).
//            "semas"   = 상가정보에서 body.cats(업종) 전체를 훑어 상호명으로 브랜드 점포를 찾아 demand_store_items에 누적하고 demand_store_counts(source=semas)를 다시 집계. 업종이 많아 여러 번에 나눠 실행(첫 실행에 reset:true).
//            "ftc"     = demand_brands.ftc_brand_no가 있는 브랜드의 지역별 가맹점·직영점 수를 demand_store_counts에 저장.   body.years: [2025, 2024, 2023]
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const env = (n: string) => (Deno.env.get(n) ?? "").trim();
const norm = (s: string) => String(s ?? "").replace(/[\s·・\-_()]/g, "").toLowerCase();

function dataGoKey() {
  let k = env("DATAGO_SERVICE_KEY");
  if (/%[0-9A-Fa-f]{2}/.test(k)) k = decodeURIComponent(k); // Encoding 키를 넣었어도 이중 인코딩이 되지 않게
  return k;
}
async function callApi(path: string, params: Record<string, string | number>) {
  const u = new URL("https://apis.data.go.kr" + path);
  u.searchParams.set("serviceKey", dataGoKey());
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u);
  const text = await r.text();
  if (!r.ok) throw new Error(`공공데이터 API ${r.status}: ${text.replaceAll(dataGoKey(), "***").slice(0, 160)}`);
  // deno-lint-ignore no-explicit-any
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error(`공공데이터 응답을 읽지 못했습니다: ${text.replaceAll(dataGoKey(), "***").slice(0, 160)}`); }
  if (j.resultCode && j.resultCode !== "00") throw new Error(`공공데이터 오류 ${j.resultCode}: ${j.resultMsg}`);
  return j;
}
// 페이지를 넘기며 전부 가져온다 (한 페이지 최대 1000건을 시도, 거절되면 100건)
// deno-lint-ignore no-explicit-any
async function fetchAllPages(path: string, params: Record<string, string | number>): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const all: any[] = [];
  let size = 1000;
  for (let page = 1; page <= 200; page++) {
    let j;
    try { j = await callApi(path, { ...params, pageNo: page, numOfRows: size, resultType: "json" }); }
    catch (e) { if (size > 100 && page === 1) { size = 100; page = 0; continue; } throw e; }
    const items = j.items ?? j.body?.items ?? [];
    all.push(...items);
    if (all.length >= Number(j.totalCount ?? 0) || items.length === 0) break;
  }
  return all;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const cron = req.headers.get("x-cron-secret");
    let ok = false;
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
    }
    if (!dataGoKey()) return json({ error: "DATAGO_SERVICE_KEY가 등록되지 않았습니다." }, 400);
    const body = await req.json().catch(() => ({}));
    const mode: string = body.mode ?? "resolve";
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    if (mode === "resolve") {
      const years: number[] = body.years ?? [2025, 2024, 2023];
      const { data: brs } = await admin.from("demand_brands").select("id,name,aliases").neq("status", "excluded").order("id");
      const out: Record<string, unknown> = {};
      for (const y of years) {
        try {
          const list = await fetchAllPages("/1130000/FftcBrandRlsInfo2_Service/getBrandinfo", { jngBizCrtraYr: y });
          const rows = list.map((x) => ({ no: x.brandMnno as string, nm: String(x.brandNm ?? ""), corp: String(x.corpNm ?? x.jnghdqrtrsNm ?? "") }));
          const matches: Record<string, unknown[]> = {};
          for (const b of brs ?? []) {
            const names = [b.name, ...(b.aliases ?? [])];
            const keys = new Set<string>();
            for (const n of names) { keys.add(norm(n)); for (const t of String(n).split(/\s+/)) if (norm(t).length >= 3) keys.add(norm(t)); }
            const hit = rows.filter((r) => { const rn = norm(r.nm); return [...keys].some((k) => k && (rn.includes(k) || (rn.length >= 3 && k.includes(rn)))); });
            matches[b.name] = hit.slice(0, 8);
          }
          out[String(y)] = { total: list.length, sample: list[0] ? Object.keys(list[0]) : [], matches };
        } catch (e) { out[String(y)] = { error: (e as Error).message }; }
      }
      return json({ ok: true, result: out });
    }
    // ftc: 브랜드관리번호가 있는 브랜드의 지역별 가맹점·직영점 수를 기준년도별로 받아 저장한다 (body.years 기본 [2025,2024,2023])
    if (mode === "ftc") {
      const years: number[] = body.years ?? [2025, 2024, 2023];
      const { data: brs } = await admin.from("demand_brands").select("id,name,ftc_brand_no").not("ftc_brand_no", "is", null).neq("status", "excluded");
      const report: Record<string, unknown> = {};
      for (const b of brs ?? []) {
        const per: Record<string, unknown> = {};
        for (const y of years) {
          try {
            const rows = await fetchAllPages("/1130000/FftcBrandFrcsDropInfo3_Service/getbrandFrcsDmsstus2", { jngBizCrtraYr: y, brandMnno: b.ftc_brand_no });
            // 같은 지역이 여러 줄(회계연도·가맹본부별)로 올 수 있어 지역별로 합산
            const byArea = new Map<string, { f: number; d: number }>();
            for (const r of rows) {
              const a = String(r.areaNm ?? "전체");
              const cur = byArea.get(a) ?? { f: 0, d: 0 };
              cur.f += Number(r.frcsCnt ?? 0); cur.d += Number(r.dmsCnt ?? 0);
              byArea.set(a, cur);
            }
            // 응답에 '전체' 지역 행이 이미 있으면 그 값을 합계로 쓰고, 없으면 지역 합으로 만든다 (같은 키가 겹치면 저장이 거절되므로 한 번만 넣는다)
            const areaRows = [...byArea.entries()].filter(([a]) => a !== "전체");
            const tf = byArea.has("전체") ? byArea.get("전체")!.f : areaRows.reduce((a, [, v]) => a + v.f, 0);
            const td = byArea.has("전체") ? byArea.get("전체")!.d : areaRows.reduce((a, [, v]) => a + v.d, 0);
            const stamp = new Date().toISOString();
            const up = [...areaRows.map(([area, v]) => ({ brand_id: b.id, source: "ftc", period: String(y), area, frcs: v.f, dms: v.d, total: v.f + v.d, collected_at: stamp })),
              ...(byArea.size ? [{ brand_id: b.id, source: "ftc", period: String(y), area: "전체", frcs: tf, dms: td, total: tf + td, collected_at: stamp }] : [])];
            if (up.length) {
              const { error } = await admin.from("demand_store_counts").upsert(up);
              if (error) throw new Error("저장 실패: " + error.message);
            }
            per[String(y)] = up.length ? { rows: rows.length, areas: areaRows.length, frcs: tf, dms: td } : "자료 없음";
          } catch (e) { per[String(y)] = "오류: " + (e as Error).message; }
        }
        report[b.name] = per;
      }
      return json({ ok: true, report });
    }
    // semas: 소상공인 상가(상권)정보에서 후보 업종의 전국 점포 목록을 받아, 상호명에 브랜드 이름이 들어간 점포를 센다.
    //   상호명 검색 기능이 없어서 업종 전체를 1000건씩 훑는다. 기준년월은 응답에 따른다(수개월 늦을 수 있음).
    if (mode === "semas") {
      const t0 = Date.now();
      const cats: Array<[string, string]> = body.cats ?? [["indsSclsCd", "I20102"], ["indsMclsCd", "I207"], ["indsMclsCd", "I202"], ["indsMclsCd", "I203"]];
      const { data: brs } = await admin.from("demand_brands").select("id,name,aliases").neq("status", "excluded").order("id");
      const keysOf = (b: { name: string; aliases: string[] | null }) => [b.name, ...(b.aliases ?? [])].map(norm).filter((k) => k.length >= 3);
      const found = new Map<number, Map<string, { area: string; name: string; cat: string }>>(); // brand_id → (bizesId → 정보)
      for (const b of brs ?? []) found.set(b.id, new Map());
      let stdrYm = "";
      let pagesDone = 0, scanned = 0;
      const semasCall = async (divId: string, key: string, pageNo: number) => {
        const u = new URL("https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInUpjong");
        u.searchParams.set("ServiceKey", dataGoKey());
        for (const [k, v] of Object.entries({ divId, key, numOfRows: 1000, pageNo, type: "json" })) u.searchParams.set(k, String(v));
        const r = await fetch(u);
        const text = await r.text();
        if (!r.ok) throw new Error(`상가정보 API ${r.status}: ${text.replaceAll(dataGoKey(), "***").slice(0, 120)}`);
        // deno-lint-ignore no-explicit-any
        const j: any = JSON.parse(text);
        if (j.header?.resultCode && j.header.resultCode !== "00") throw new Error(`상가정보 오류 ${j.header.resultCode}: ${j.header.resultMsg}`);
        return j;
      };
      const catReport: Record<string, unknown> = {};
      for (const [divId, key] of cats) {
        const first = await semasCall(divId, key, 1);
        const total = Number(first.body?.totalCount ?? 0);
        const pages = Math.ceil(total / 1000);
        stdrYm = stdrYm || String(first.header?.stdrYm ?? first.body?.items?.[0]?.stdrYm ?? "");
        // deno-lint-ignore no-explicit-any
        const eat = (items: any[], cat: string) => {
          for (const it of items) {
            scanned++;
            const nm = norm(String(it.bizesNm ?? ""));
            for (const b of brs ?? []) {
              if (keysOf(b).some((k) => nm.includes(k))) found.get(b.id)!.set(String(it.bizesId), { area: String(it.ctprvnNm ?? "기타"), name: String(it.bizesNm ?? "") + (it.brchNm ? " " + it.brchNm : ""), cat });
            }
          }
        };
        eat(first.body?.items ?? [], key);
        let next = 2;
        const worker = async () => {
          while (next <= pages && Date.now() - t0 < 120000) {
            const p = next++;
            try { const j = await semasCall(divId, key, p); eat(j.body?.items ?? [], key); pagesDone++; } catch (e) { catReport[`${key}#${p}`] = (e as Error).message; }
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        catReport[key] = { total, pages };
        pagesDone++;
        if (Date.now() - t0 >= 120000) { catReport["중단"] = "시간 제한으로 일부 업종을 끝까지 못 돌았습니다."; break; }
      }
      const period = stdrYm || "unknown";
      const stamp = new Date().toISOString();
      if (body.reset) await admin.from("demand_store_items").delete().eq("source", "semas").eq("period", period); // 새 기간 첫 실행: 이전에 모은 목록을 비우고 시작
      // 이번에 찾은 점포를 누적 저장(점포번호 기준 중복 제거)
      for (const b of brs ?? []) {
        const items = [...found.get(b.id)!.entries()].map(([ext_id, v]) => ({ brand_id: b.id, source: "semas", period, ext_id, area: v.area, name: v.name, cat: v.cat }));
        for (let i = 0; i < items.length; i += 500) await admin.from("demand_store_items").upsert(items.slice(i, i + 500));
      }
      // 누적된 목록에서 브랜드·지역별 개수를 다시 집계해 점포 수 표에 저장
      const result: Record<string, unknown> = {};
      for (const b of brs ?? []) {
        const { data: all } = await admin.from("demand_store_items").select("area").eq("brand_id", b.id).eq("source", "semas").eq("period", period).limit(5000);
        const byArea = new Map<string, number>();
        for (const r of all ?? []) byArea.set(r.area ?? "기타", (byArea.get(r.area ?? "기타") ?? 0) + 1);
        await admin.from("demand_store_counts").delete().eq("brand_id", b.id).eq("source", "semas").eq("period", period);
        const rows = [...byArea.entries()].map(([area, n]) => ({ brand_id: b.id, source: "semas", period, area, frcs: null, dms: null, total: n, collected_at: stamp }));
        rows.push({ brand_id: b.id, source: "semas", period, area: "전체", frcs: null, dms: null, total: (all ?? []).length, collected_at: stamp });
        const { error } = await admin.from("demand_store_counts").insert(rows);
        result[b.name] = error ? "저장 실패: " + error.message : (all ?? []).length;
      }
      return json({ ok: true, period, scanned, pagesDone, seconds: Math.round((Date.now() - t0) / 1000), cats: catReport, result });
    }
    return json({ error: "알 수 없는 mode" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
