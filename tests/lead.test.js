const test = require("node:test");
const assert = require("node:assert/strict");
const { validate, normalize, normalizePhone } = require("../api/lead")._test;
const valid = { name: "María López", phone: "+54 9 2291 123456", location: "Miramar", inquiryType: "hogar", consent: true, event_id: "1234567890-abcd", event_source_url: "https://example.com/" };
test("acepta un lead válido", () => assert.deepEqual(validate(valid), []));
test("automotor exige vehículo y año", () => assert.ok(validate({ ...valid, inquiryType: "automotor" }).includes("vehicle")));
test("rechaza evento y URL inválidos", () => assert.deepEqual(validate({ ...valid, event_id: "x", event_source_url: "javascript:alert(1)" }).filter(x => x.startsWith("event")), ["event_id", "event_source_url"]));
test("normaliza datos para hashing", () => { assert.equal(normalize("  María  "), "maria"); assert.equal(normalizePhone("+54 9 2291-123456"), "5492291123456"); });
