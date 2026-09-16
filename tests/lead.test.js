const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/lead");
const api = handler._test;
const client = require("../js/validation");

const base = { name: "María López", phone: "02291 15-123456", location: "Miramar", inquiryType: "hogar", consent: true, analytics_consent: false, event_id: "event-1234567890", event_source_url: "http://localhost:8000/cotizar" };
function response() { return { headers: {}, statusCode: 0, body: null, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, end() { return this; } }; }
async function request(body, headers = {}) { const req = { method: "POST", body, headers: { origin: "http://localhost:8000", "x-forwarded-for": `127.0.0.${Math.floor(Math.random() * 200)}`, ...headers }, socket: {} }; const res = response(); await handler(req, res); return res; }
const originalEnv = { ...process.env }; const originalFetch = global.fetch;

test("suite auditable del lead", async (t) => {
  process.env.NODE_ENV = "test"; process.env.ALLOWED_ORIGINS = "https://seguros.test";
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.RESEND_API_KEY = "test"; process.env.LEAD_TO_EMAIL = "to@example.com"; process.env.LEAD_FROM_EMAIL = "from@example.com";
  delete process.env.META_PIXEL_ID; delete process.env.META_ACCESS_TOKEN;
  api.memory.events.clear(); api.memory.rates.clear();

  await t.test("validación compartida y automotor exige vehículo y año", () => {
    assert.deepEqual(api.validate(base), []);
    assert.deepEqual(client.validateLead({ ...base, inquiryType: "automotor" }, 2026), { vehicle: "Ingresá marca y modelo.", year: "Ingresá un año válido." });
    assert.deepEqual(api.validate({ ...base, inquiryType: "automotor" }).filter((x) => ["vehicle", "year"].includes(x)), ["vehicle", "year"]);
  });
  await t.test("normaliza formatos argentinos con 0, 15, 54 y 9", () => {
    for (const input of ["02291 15 123456", "+54 9 2291 123456", "54 9 2291 123456", "2291 123456"]) assert.equal(api.normalizeArgentinePhone(input), "5492291123456");
    assert.equal(client.normalizeArgentinePhone("011 15 1234-5678"), "5491112345678");
    assert.equal(api.normalizeArgentinePhone("123"), "");
  });
  await t.test("CORS solo refleja orígenes permitidos", async () => {
    const denied = await request(base, { origin: "https://evil.test" }); assert.equal(denied.statusCode, 403); assert.equal(denied.headers["Access-Control-Allow-Origin"], undefined);
    const req = { method: "OPTIONS", headers: { origin: "https://seguros.test" } }; const res = response(); await handler(req, res); assert.equal(res.statusCode, 204); assert.equal(res.headers["Access-Control-Allow-Origin"], "https://seguros.test");
  });
  await t.test("event_source_url exige un origen permitido y localhost es solo desarrollo", () => {
    assert.equal(api.validSourceUrl("https://seguros.test/form"), true); assert.equal(api.validSourceUrl("https://evil.test/form"), false);
    process.env.NODE_ENV = "production"; assert.equal(api.validSourceUrl("http://localhost:8000/form"), false); process.env.NODE_ENV = "test";
  });
  await t.test("rate limiting bloquea al superar el cupo", async () => {
    const ip = "10.1.2.3"; for (let i = 0; i < 8; i++) assert.equal(await api.rateLimit(ip), true); assert.equal(await api.rateLimit(ip), false);
  });
  await t.test("idempotencia distingue processing y delivered", async () => {
    const id = "idem-processing-01"; assert.deepEqual(await api.claimEvent(id), { claimed: true, state: "processing" }); assert.deepEqual(await api.claimEvent(id), { claimed: false, state: "processing" });
    await api.setEventState(id, "delivered"); assert.deepEqual(await api.claimEvent(id), { claimed: false, state: "delivered" });
  });
  await t.test("duplicado processing no se informa entregado", async () => {
    const body = { ...base, event_id: "processing-duplicate-01" }; await api.claimEvent(body.event_id); const res = await request(body); assert.equal(res.statusCode, 409); assert.equal(res.body.lead_received, false); assert.equal(res.body.idempotency, "processing");
  });
  await t.test("duplicado delivered se confirma sin reenviar email", async () => {
    const body = { ...base, event_id: "delivered-duplicate-01" }; await api.claimEvent(body.event_id); await api.setEventState(body.event_id, "delivered"); let calls = 0; global.fetch = async () => { calls++; return { ok: true }; };
    const res = await request(body); assert.equal(res.statusCode, 200); assert.equal(res.body.lead_received, true); assert.equal(res.body.idempotency, "duplicate_delivered"); assert.equal(calls, 0);
  });
  await t.test("fallo de Resend libera el claim y permite reintentar con el mismo event_id", async () => {
    const body = { ...base, event_id: "resend-retry-0001" }; global.fetch = async () => ({ ok: false, status: 500 }); const failed = await request(body); assert.equal(failed.statusCode, 503); assert.equal(failed.body.idempotency, "released");
    global.fetch = async () => ({ ok: true }); const retried = await request(body); assert.equal(retried.body.lead_received, true); assert.equal(retried.body.idempotency, "created");
  });
  await t.test("fallo CAPI posterior al email mantiene lead entregado", async () => {
    process.env.META_PIXEL_ID = "123456789"; process.env.META_ACCESS_TOKEN = "token"; const body = { ...base, event_id: "capi-failure-0001", analytics_consent: true }; global.fetch = async (url) => url.includes("resend") ? { ok: true } : { ok: false, status: 500 };
    const res = await request(body); assert.equal(res.statusCode, 200); assert.equal(res.body.lead_received, true); assert.equal(res.body.capi_sent, false); delete process.env.META_PIXEL_ID; delete process.env.META_ACCESS_TOKEN;
  });
  await t.test("fallo Redis después de Resend no convierte la entrega en error", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test"; process.env.UPSTASH_REDIS_REST_TOKEN = "token"; const body = { ...base, event_id: "redis-after-mail-01" }; let incr = 0;
    global.fetch = async (url) => { if (url.includes("api.resend.com")) return { ok: true }; if (url.includes("/incr/")) return { ok: true, json: async () => ({ result: ++incr }) }; if (url.includes("/expire/")) return { ok: true, json: async () => ({ result: 1 }) }; if (url.includes("/set/") && url.includes("processing")) return { ok: true, json: async () => ({ result: "OK" }) }; throw new Error("Redis unavailable after delivery"); };
    const res = await request(body); assert.equal(res.statusCode, 200); assert.equal(res.body.lead_received, true); delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });
  await t.test("analítica rechazada no envía CAPI y exige booleano estricto", async () => {
    assert.ok(api.validate({ ...base, analytics_consent: "false" }).includes("analytics_consent")); process.env.META_PIXEL_ID = "123456789"; process.env.META_ACCESS_TOKEN = "token"; let calls = 0; global.fetch = async () => { calls++; return { ok: true }; };
    const sent = await api.sendCapi({ ...base, analytics_consent: false }, { headers: {}, socket: {} }); assert.equal(sent, false); assert.equal(calls, 0); delete process.env.META_PIXEL_ID; delete process.env.META_ACCESS_TOKEN;
  });
  await t.test("Pixel y CAPI usan exactamente el mismo event_id", async () => {
    process.env.META_PIXEL_ID = "123456789"; process.env.META_ACCESS_TOKEN = "token"; let payload; global.fetch = async (_url, options) => { payload = JSON.parse(options.body); return { ok: true }; };
    await api.sendCapi({ ...base, analytics_consent: true }, { headers: {}, socket: {} }); assert.equal(payload.data[0].event_id, base.event_id);
    const frontend = require("node:fs").readFileSync("js/main.js", "utf8"); assert.match(frontend, /track\("Lead", \{ content_name: type\.value \}, currentEventId\)/); assert.match(frontend, /event_id: currentEventId/); delete process.env.META_PIXEL_ID; delete process.env.META_ACCESS_TOKEN;
  });
  await t.test("destildar consentimiento detiene eventos y reactivarlo no duplica PageView ni ViewContent", () => {
    let state = { pageViewSent: false, viewContentPending: true, viewContentSent: false };
    let transition = client.measurementTransition(state, true);
    assert.deepEqual(transition.events, ["PageView", "ViewContent"]);
    state = transition.state;
    transition = client.measurementTransition(state, false);
    assert.deepEqual(transition.events, []);
    transition = client.measurementTransition(transition.state, true);
    assert.deepEqual(transition.events, []);
    const frontend = require("node:fs").readFileSync("js/main.js", "utf8");
    assert.match(frontend, /\[name=analytics_consent\]"\)\.addEventListener\("change"/);
  });
  await t.test("fallback fbc prioriza fbclid y timestamp del último touch", () => {
    const attribution = {
      first_touch: { fbclid: "click-viejo", captured_at: "2026-01-01T00:00:00.000Z" },
      last_touch: { fbclid: "click-reciente", captured_at: "2026-09-16T12:00:00.000Z" }
    };
    assert.equal(client.buildFbc(attribution), `fb.1.${Date.parse(attribution.last_touch.captured_at)}.click-reciente`);
    assert.equal(client.buildFbc(attribution, "fb.1.cookie.actual"), "fb.1.cookie.actual");
  });
});

test.after(() => { global.fetch = originalFetch; Object.keys(process.env).forEach((key) => { if (!(key in originalEnv)) delete process.env[key]; }); Object.assign(process.env, originalEnv); });
