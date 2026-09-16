const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validate, normalize, normalizePhone, checkRateLimit, claimEvent, releaseEvent,
  memoryRateLimits, memoryEvents
} = require("../api/lead")._test;

const valid = { name: "María López", phone: "+54 9 2291 123456", location: "Miramar", inquiryType: "hogar", consent: true, event_id: "1234567890-abcd", event_source_url: "https://example.com/" };

test.beforeEach(() => { memoryRateLimits.clear(); memoryEvents.clear(); });

test("acepta un lead válido", () => assert.deepEqual(validate(valid), []));
test("automotor exige vehículo y año por separado", () => {
  const errors = validate({ ...valid, inquiryType: "automotor" });
  assert.ok(errors.includes("vehicle"));
  assert.ok(errors.includes("year"));
});
test("rechaza evento, URL, teléfono y consentimiento inválidos", () => {
  const errors = validate({ ...valid, phone: "123", consent: false, event_id: "x", event_source_url: "javascript:alert(1)" });
  assert.deepEqual(errors.filter((field) => ["phone", "consent", "event_id", "event_source_url"].includes(field)), ["phone", "consent", "event_id", "event_source_url"]);
});
test("acepta localhost HTTP para desarrollo pero exige HTTPS en otros hosts", () => {
  assert.equal(validate({ ...valid, event_source_url: "http://localhost:3000/" }).includes("event_source_url"), false);
  assert.equal(validate({ ...valid, event_source_url: "http://example.com/" }).includes("event_source_url"), true);
});
test("normaliza datos para hashing", () => {
  assert.equal(normalize("  María  "), "maria");
  assert.equal(normalizePhone("+54 9 2291-123456"), "5492291123456");
});
test("limita el sexto intento de una IP en la ventana", async () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.10" } };
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(await checkRateLimit(req), true);
  assert.equal(await checkRateLimit(req), false);
});
test("la clave de idempotencia solo se reclama una vez y puede liberarse", async () => {
  assert.equal(await claimEvent(valid.event_id), true);
  assert.equal(await claimEvent(valid.event_id), false);
  await releaseEvent(valid.event_id);
  assert.equal(await claimEvent(valid.event_id), true);
});
