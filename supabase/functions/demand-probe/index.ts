// 진단용 임시 함수: 공공데이터포털(apis.data.go.kr) API를 서버 키로 호출해 응답 앞부분만 돌려준다. 키는 응답·로그에 남기지 않는다.
// 호출 권한: 예약 비밀값(x-cron-secret = DB demand_private.cron_secret) 또는 기획자 JWT. 호스트는 apis.data.go.kr 하나로 제한.
// body: { url: "https://apis.data.go.kr/...", params?: { 이름: 값 }, keyParam?: "serviceKey" | "ServiceKey", max?: 글자수 }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

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
    const body = await req.json().catch(() => ({}));
    const url = new URL(String(body.url ?? ""));
    if (url.hostname !== "apis.data.go.kr") return json({ error: "apis.data.go.kr 주소만 호출할 수 있습니다." }, 400);
    let key = (Deno.env.get("DATAGO_SERVICE_KEY") ?? "").trim();
    if (!key) return json({ error: "DATAGO_SERVICE_KEY가 등록되지 않았습니다." }, 400);
    if (/%[0-9A-Fa-f]{2}/.test(key)) key = decodeURIComponent(key); // Encoding 키를 넣었으면 되돌려서 이중 인코딩 방지
    url.searchParams.set(body.keyParam ?? "serviceKey", key);
    for (const [k, v] of Object.entries((body.params ?? {}) as Record<string, string>)) url.searchParams.set(k, String(v));
    const r = await fetch(url);
    const text = (await r.text()).replaceAll(key, "***").replaceAll(encodeURIComponent(key), "***");
    return json({ status: r.status, contentType: r.headers.get("content-type"), body: text.slice(0, Number(body.max) || 1500) });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
