const crypto = require("node:crypto");

const ALLOWED_TYPES = new Set(["automotor", "hogar", "comercio", "vida", "accidentes", "viajero", "general"]);
const ATTRIBUTION_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT = 8;
const RATE_WINDOW_SECONDS = 600;
const TIMEOUTS = Object.freeze({ redis: 600, resend: 3000, capi: 1800 });
const memory = { rates: new Map(), events: new Map() };

const text = (value, max = 250) => String(value ?? "").trim().slice(0, max);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalize = (value) => text(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
const htmlEscape = (value) => text(value, 500).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));

function normalizeArgentinePhone(value) {
  let digits = text(value, 40).replace(/\D/g, "").replace(/^00/, "");
  if (digits.startsWith("54")) digits = digits.slice(2);
  if (digits.startsWith("9") && digits.length === 11) digits = digits.slice(1);
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 12) {
    const marker = digits.indexOf("15", 2);
    if (marker >= 2 && marker <= 4) digits = digits.slice(0, marker) + digits.slice(marker + 2);
  }
  return digits.length === 10 ? `549${digits}` : "";
}

function configuredOrigins() {
  const origins = (process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
  if (process.env.NODE_ENV !== "production") origins.push("http://localhost:3000", "http://localhost:8000", "http://127.0.0.1:8000");
  return new Set(origins);
}

function validSourceUrl(value, origins = configuredOrigins()) {
  try {
    const url = new URL(text(value, 1000));
    return url.protocol === "https:" || (process.env.NODE_ENV !== "production" && url.protocol === "http:")
      ? origins.has(url.origin)
      : false;
  } catch { return false; }
}

function validate(body) {
  const errors = [];
  if (text(body.name, 80).length < 3 || text(body.name, 80).split(/\s+/).length < 2) errors.push("name");
  if (!normalizeArgentinePhone(body.phone)) errors.push("phone");
  if (text(body.location, 80).length < 2) errors.push("location");
  if (!ALLOWED_TYPES.has(body.inquiryType)) errors.push("inquiryType");
  if (body.inquiryType === "automotor") {
    const year = Number(body.year);
    if (text(body.vehicle, 100).length < 2) errors.push("vehicle");
    if (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1) errors.push("year");
  }
  if (body.consent !== true) errors.push("consent");
  if (typeof body.analytics_consent !== "boolean") errors.push("analytics_consent");
  if (!/^[a-zA-Z0-9-]{10,100}$/.test(text(body.event_id, 100))) errors.push("event_id");
  if (!validSourceUrl(body.event_source_url)) errors.push("event_source_url");
  return errors;
}

async function fetchWithTimeout(url, options, milliseconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function hasRedis() { return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN); }

async function redis(command) {
  const base = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
  if (!base || !process.env.UPSTASH_REDIS_REST_TOKEN) throw new Error("Redis is not configured");
  const response = await fetchWithTimeout(`${base}/${command.map((part) => encodeURIComponent(part)).join("/")}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  }, TIMEOUTS.redis);
  if (!response.ok) throw new Error(`Redis returned ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function rateLimit(ip) {
  const bucket = Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000));
  const key = `rate:lead:${hash(ip).slice(0, 24)}:${bucket}`;
  if (hasRedis()) {
    const count = Number(await redis(["incr", key]));
    if (count === 1) await redis(["expire", key, String(RATE_WINDOW_SECONDS + 5)]);
    return count <= RATE_LIMIT;
  }
  if (process.env.NODE_ENV === "production") throw new Error("Production rate limiting requires Redis");
  const current = memory.rates.get(key) || 0;
  memory.rates.set(key, current + 1);
  return current < RATE_LIMIT;
}

async function claimEvent(eventId) {
  const key = `lead:event:${eventId}`;
  if (hasRedis()) {
    const claimed = await redis(["set", key, "processing", "ex", "120", "nx"]);
    return claimed === "OK" ? { claimed: true, state: "processing" } : { claimed: false, state: await redis(["get", key]) };
  }
  if (process.env.NODE_ENV === "production") throw new Error("Production idempotency requires Redis");
  const existing = memory.events.get(key);
  if (existing && existing.expires > Date.now()) return { claimed: false, state: existing.state };
  if (existing) memory.events.delete(key);
  memory.events.set(key, { state: "processing", expires: Date.now() + 120000 });
  return { claimed: true, state: "processing" };
}

async function setEventState(eventId, state) {
  const key = `lead:event:${eventId}`;
  if (hasRedis()) return redis(["set", key, state, "ex", "604800"]);
  memory.events.set(key, { state, expires: Date.now() + 604800000 });
}

async function releaseEvent(eventId) {
  const key = `lead:event:${eventId}`;
  if (hasRedis()) return redis(["del", key]);
  memory.events.delete(key);
}

async function sendEmail(body) {
  if (!process.env.RESEND_API_KEY || !process.env.LEAD_TO_EMAIL || !process.env.LEAD_FROM_EMAIL) throw new Error("Lead delivery is not configured");
  const attribution = body.analytics_consent === true ? (body.attribution || {}) : {};
  const rows = [
    ["Nombre", body.name], ["WhatsApp", body.phone], ["Localidad", body.location], ["Consulta", body.inquiryType],
    ["Vehículo", body.vehicle], ["Año", body.year], ["URL de conversión", body.event_source_url],
    ["Fecha de conversión", body.converted_at], ["Primera interacción", attribution.first_touch?.url],
    ["Última interacción", attribution.last_touch?.url], ...ATTRIBUTION_KEYS.map((key) => [key, attribution.last_touch?.[key] || attribution[key]])
  ].filter(([, value]) => value).map(([label, value]) => `<tr><th align="left">${htmlEscape(label)}</th><td>${htmlEscape(value)}</td></tr>`).join("");
  const response = await fetchWithTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `lead/${body.event_id}` },
    body: JSON.stringify({ from: process.env.LEAD_FROM_EMAIL, to: [process.env.LEAD_TO_EMAIL], reply_to: process.env.LEAD_REPLY_TO || undefined, subject: `Nueva consulta: ${text(body.inquiryType, 30)}`, html: `<h1>Nueva consulta desde ME Seguros</h1><table cellpadding="7">${rows}</table><p>Consentimiento de contacto: sí</p>` })
  }, TIMEOUTS.resend);
  if (!response.ok) throw new Error(`Delivery provider returned ${response.status}`);
}

async function sendCapi(body, req) {
  if (body.analytics_consent !== true || !process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return false;
  const names = text(body.name, 80).trim().split(/\s+/).map(normalize).filter(Boolean);
  const attribution = body.attribution || {};
  const last = attribution.last_touch || attribution;
  const userData = {
    ph: [hash(normalizeArgentinePhone(body.phone))], fn: names[0] ? [hash(names[0])] : undefined,
    ln: names.length > 1 ? [hash(names.slice(1).join(""))] : undefined, ct: [hash(normalize(body.location))], country: [hash("ar")],
    client_ip_address: text(req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress, 64) || undefined,
    client_user_agent: text(req.headers["user-agent"], 500) || undefined, fbp: text(body.fbp, 250) || undefined, fbc: text(body.fbc, 250) || undefined
  };
  Object.keys(userData).forEach((key) => userData[key] === undefined && delete userData[key]);
  const payload = { data: [{ event_name: "Lead", event_time: Math.floor(Date.now() / 1000), event_id: body.event_id, event_source_url: body.event_source_url, action_source: "website", user_data: userData, custom_data: { content_name: body.inquiryType, lead_type: "quote_form", ...Object.fromEntries(ATTRIBUTION_KEYS.slice(0, 5).map((key) => [key, text(last[key])]).filter(([, value]) => value)) } }] };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  const version = /^v\d+\.\d+$/.test(process.env.META_API_VERSION || "") ? process.env.META_API_VERSION : "v23.0";
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(process.env.META_PIXEL_ID)}/events?access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const response = await fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, TIMEOUTS.capi);
  if (!response.ok) console.error("Meta CAPI request failed", response.status);
  return response.ok;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && configuredOrigins().has(origin.replace(/\/$/, ""))) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return req.headers.origin && !res.getHeader("Access-Control-Allow-Origin") ? res.status(403).end() : res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ lead_received: false, error: "Method not allowed" });
  if (req.headers.origin && !res.getHeader("Access-Control-Allow-Origin")) return res.status(403).json({ lead_received: false, error: "Origin not allowed" });
  if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) return res.status(413).json({ lead_received: false, error: "Body too large" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ lead_received: false, error: "JSON inválido" }); }
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) return res.status(413).json({ lead_received: false, error: "Body too large" });
  if (body.company) return res.status(200).json({ lead_received: false, capi_sent: false, idempotency: "honeypot" });
  const errors = validate(body);
  if (errors.length) return res.status(400).json({ lead_received: false, error: "Datos inválidos", fields: errors });

  const ip = text(req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "unknown", 64);
  try { if (!await rateLimit(ip)) return res.status(429).json({ lead_received: false, error: "Demasiados intentos", retryable: true }); }
  catch (error) { console.error("Rate limit error", error.message); return res.status(503).json({ lead_received: false, error: "Servicio temporalmente no disponible", retryable: true }); }

  let claim;
  try { claim = await claimEvent(body.event_id); }
  catch (error) { console.error("Idempotency claim error", error.message); return res.status(503).json({ lead_received: false, error: "Servicio temporalmente no disponible", retryable: true }); }
  if (!claim.claimed) {
    if (claim.state === "delivered" || claim.state === "delivered:capi") return res.status(200).json({ lead_received: true, capi_sent: claim.state === "delivered:capi", idempotency: "duplicate_delivered" });
    return res.status(409).json({ lead_received: false, capi_sent: false, idempotency: "processing", retryable: true });
  }

  try { await sendEmail(body); }
  catch (error) {
    console.error("Lead delivery error", error.message);
    await releaseEvent(body.event_id).catch((releaseError) => console.error("Claim release error", releaseError.message));
    return res.status(503).json({ lead_received: false, capi_sent: false, idempotency: "released", error: "No se pudo entregar la consulta", retryable: true });
  }

  await setEventState(body.event_id, "delivered").catch((error) => console.error("Delivered state error", error.message));
  const capiSent = await sendCapi(body, req).catch((error) => { console.error("CAPI error", error.message); return false; });
  if (capiSent) await setEventState(body.event_id, "delivered:capi").catch((error) => console.error("CAPI state error", error.message));
  return res.status(200).json({ lead_received: true, capi_sent: capiSent, idempotency: "created" });
}

module.exports = handler;
module.exports._test = { validate, validSourceUrl, normalize, normalizeArgentinePhone, configuredOrigins, rateLimit, claimEvent, setEventState, releaseEvent, sendCapi, memory, TIMEOUTS, MAX_BODY_BYTES };
