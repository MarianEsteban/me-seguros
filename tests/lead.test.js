const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/lead");
const { validate, normalize, normalizePhone } = handler._test;

const valid = { name: "María López", phone: "+54 9 2291 123456", location: "Miramar", inquiryType: "hogar", consent: true, event_id: "1234567890-abcd", event_source_url: "https://seguros.test/cotizar", attribution: { first_touch: { utm_source: "meta" }, last_touch: { utm_campaign: "autos" }, conversion_url: "https://seguros.test/cotizar", converted_at: "2026-09-16T12:00:00.000Z" } };

function response() {
  return { headers: {}, statusCode: 200, setHeader(key, value) { this.headers[key] = value; }, getHeader(key) { return this.headers[key]; }, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; }, end() { return this; } };
}

function request(body = valid, overrides = {}) {
  return { method: "POST", body, headers: { origin: "https://seguros.test", "x-forwarded-for": "203.0.113.4", "user-agent": "test" }, socket: {}, ...overrides };
}

function configure() {
  Object.assign(process.env, { NODE_ENV: "production", VERCEL_ENV: "production", ALLOWED_ORIGINS: "https://seguros.test", RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "leads@test.invalid", LEAD_FROM_EMAIL: "web@test.invalid", META_PIXEL_ID: "123456", META_ACCESS_TOKEN: "token" });
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
}

test.beforeEach(configure);
test.afterEach(() => { global.fetch = undefined; });

test("acepta un lead válido y normaliza teléfonos argentinos", () => {
  assert.deepEqual(validate(valid), []);
  assert.equal(normalize("  María  "), "maria");
  assert.equal(normalizePhone("02291 15-123456"), "5492291123456");
  assert.equal(normalizePhone("+54 2291 15-123456"), "5492291123456");
});

test("automotor exige vehículo y la URL debe pertenecer a ALLOWED_ORIGINS", () => {
  assert.ok(validate({ ...valid, inquiryType: "automotor" }).includes("vehicle"));
  assert.ok(validate({ ...valid, event_source_url: "https://evil.test/" }).includes("event_source_url"));
});

test("entrega email y CAPI e informa estados separados", async () => {
  const calls = [];
  global.fetch = async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, status: 200, text: async () => "", json: async () => ({}) }; };
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, lead_received: true, capi_sent: true, status: "delivered:capi" });
  assert.match(calls[0].options.body, /first_touch\.utm_source/);
  const capi = JSON.parse(calls[1].options.body);
  assert.equal(capi.data[0].user_data.ph[0], require("node:crypto").createHash("sha256").update("5492291123456").digest("hex"));
});

test("conserva éxito del lead si CAPI falla", async () => {
  global.fetch = async (url) => String(url).includes("resend") ? { ok: true, status: 200 } : { ok: false, status: 500, text: async () => "error" };
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.lead_received, true);
  assert.equal(res.body.capi_sent, false);
  assert.equal(res.body.status, "delivered");
});

test("permite reintentar tras fallo de email y no duplica una entrega", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "secret";
  const store = new Map();
  let emailAttempts = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes("redis.test")) {
      const [command, key, value] = JSON.parse(options.body);
      let result;
      if (command === "SET" && JSON.parse(options.body).includes("NX")) { result = store.has(key) ? null : "OK"; if (result) store.set(key, value); }
      else if (command === "SET") { store.set(key, value); result = "OK"; }
      else if (command === "GET") result = store.get(key) || null;
      else if (command === "DEL") result = store.delete(key) ? 1 : 0;
      else if (command === "INCR") { result = Number(store.get(key) || 0) + 1; store.set(key, result); }
      else result = 1;
      return { ok: true, json: async () => ({ result }) };
    }
    if (String(url).includes("resend")) { emailAttempts++; return { ok: emailAttempts > 1, status: emailAttempts > 1 ? 200 : 500 }; }
    return { ok: true, status: 200, text: async () => "" };
  };
  const first = response(); await handler(request(), first); assert.equal(first.statusCode, 503);
  const retry = response(); await handler(request(), retry); assert.equal(retry.body.lead_received, true);
  const duplicate = response(); await handler(request(), duplicate); assert.equal(duplicate.body.status, "delivered:capi");
  assert.equal(emailAttempts, 2);
});

test("un duplicado processing no se presenta como exitoso", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "secret";
  global.fetch = async (url, options) => {
    const command = JSON.parse(options.body);
    if (command[0] === "INCR" || command[0] === "EXPIRE") return { ok: true, json: async () => ({ result: 1 }) };
    if (command[0] === "SET") return { ok: true, json: async () => ({ result: null }) };
    return { ok: true, json: async () => ({ result: "processing" }) };
  };
  const res = response(); await handler(request(), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.lead_received, false);
});

test("CORS rechaza origins no permitidos", async () => {
  const res = response();
  await handler(request(valid, { headers: { origin: "https://evil.test" } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.getHeader("Access-Control-Allow-Origin"), undefined);
});

test("rate limiting devuelve 429", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "secret";
  process.env.RATE_LIMIT_PER_MINUTE = "1";
  global.fetch = async (url, options) => {
    const command = JSON.parse(options.body);
    return { ok: true, json: async () => ({ result: command[0] === "INCR" ? 2 : 1 }) };
  };
  const res = response(); await handler(request(), res);
  assert.equal(res.statusCode, 429);
});
