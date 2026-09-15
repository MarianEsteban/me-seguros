const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../api/lead");
const { validate, normalize, normalizePhone, originAllowed, memory } = api._test;

const valid = { name: "María López", phone: "+54 9 2291 123456", location: "Miramar", inquiryType: "hogar", consent: true, tracking_consent: false, form_elapsed_ms: 2000, event_id: "1234567890-abcd", event_source_url: "https://me-seguros.vercel.app/" };

function response() {
  return { statusCode: 200, headers: {}, body: undefined, setHeader(key, value) { this.headers[key] = value; }, getHeader(key) { return this.headers[key]; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, end() { return this; } };
}

function request(body, overrides = {}) {
  return { method: "POST", body, headers: { origin: "https://me-seguros.vercel.app", host: "me-seguros.vercel.app", "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}`, "user-agent": "test" }, socket: {}, ...overrides };
}

test.beforeEach(() => {
  memory.clear();
  process.env.ALLOWED_ORIGINS = "https://me-seguros.vercel.app";
  process.env.RESEND_API_KEY = "test";
  process.env.LEAD_TO_EMAIL = "lead@example.com";
  process.env.LEAD_FROM_EMAIL = "from@example.com";
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.META_PIXEL_ID;
  delete process.env.META_ACCESS_TOKEN;
});

test("valida el lead, el origen y el teléfono argentino normalizado", () => {
  assert.deepEqual(validate(valid, "https://me-seguros.vercel.app"), []);
  assert.equal(normalize("  María  "), "maria");
  assert.equal(normalizePhone("+54 9 2291-15-123456"), "5492291123456");
  assert.equal(originAllowed("https://evil.example"), false);
  assert.ok(validate({ ...valid, event_source_url: "https://evil.example/" }, "https://me-seguros.vercel.app").includes("event_source_url"));
});

test("automotor exige vehículo y año", () => assert.ok(validate({ ...valid, inquiryType: "automotor" }, valid.event_source_url).includes("vehicle")));

test("entrega una sola vez y el reintento con event_id devuelve el resultado guardado", async (t) => {
  let emails = 0;
  t.mock.method(global, "fetch", async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.headers["Idempotency-Key"], valid.event_id);
    emails += 1;
    return { ok: true, status: 200, json: async () => ({ id: "email" }) };
  });
  const first = response(); await api(request(valid), first);
  const second = response(); await api(request(valid), second);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body, { ok: true, lead_received: true, capi_sent: false });
  assert.equal(second.body.duplicate, true);
  assert.equal(emails, 1);
});

test("confirma el lead aunque CAPI falle", async (t) => {
  process.env.META_PIXEL_ID = "123456";
  process.env.META_ACCESS_TOKEN = "token";
  let calls = 0;
  t.mock.method(global, "fetch", async () => (++calls === 1 ? { ok: true, status: 200 } : { ok: false, status: 500 }));
  const res = response();
  await api(request({ ...valid, event_id: "capi-failure-123", tracking_consent: true }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.lead_received, true);
  assert.equal(res.body.capi_sent, false);
  assert.equal(res.body.warning, "tracking_unavailable");
});

test("rechaza abuso, CORS no permitido y JSON inválido", async () => {
  const fast = response(); await api(request({ ...valid, form_elapsed_ms: 100 }), fast);
  assert.equal(fast.statusCode, 400);
  const cors = response(); await api(request(valid, { headers: { origin: "https://evil.example" } }), cors);
  assert.equal(cors.statusCode, 403);
  const invalid = response(); await api(request("{"), invalid);
  assert.equal(invalid.statusCode, 400);
});

test("aplica rate limiting por IP", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: true, status: 200 }));
  let last;
  for (let index = 0; index < 6; index += 1) {
    last = response();
    await api(request({ ...valid, event_id: `rate-event-${index}` }, { headers: { origin: valid.event_source_url.slice(0, -1), host: "me-seguros.vercel.app", "x-forwarded-for": "198.51.100.22" } }), last);
  }
  assert.equal(last.statusCode, 429);
});
