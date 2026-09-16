const crypto = require("node:crypto");

const ALLOWED_TYPES = new Set(["automotor", "hogar", "comercio", "vida", "accidentes", "viajero", "general"]);
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 10 * 60;
const IDEMPOTENCY_SECONDS = 24 * 60 * 60;
const memoryRateLimits = new Map();
const memoryEvents = new Map();

const text = (value, max = 250) => String(value || "").trim().slice(0, max);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalize = (value) => text(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const normalizePhone = (value) => text(value).replace(/\D/g, "");
const htmlEscape = (value) => text(value, 500).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
const clientIp = (req) => text(req.headers["x-forwarded-for"]?.split(",")[0] || req.headers["x-real-ip"] || "unknown", 64);

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean);
}

function setCors(req, res) {
  const origin = text(req.headers.origin, 300).replace(/\/$/, "");
  if (origin && allowedOrigins().includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

function validate(body) {
  const errors = [];
  if (text(body.name, 81).length < 2 || text(body.name, 81).length > 80) errors.push("name");
  const phone = normalizePhone(body.phone);
  if (phone.length < 8 || phone.length > 15) errors.push("phone");
  if (text(body.location, 81).length < 2 || text(body.location, 81).length > 80) errors.push("location");
  if (!ALLOWED_TYPES.has(body.inquiryType)) errors.push("inquiryType");
  if (body.inquiryType === "automotor") {
    const year = Number(body.year);
    if (!text(body.vehicle, 101) || text(body.vehicle, 101).length > 100) errors.push("vehicle");
    if (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1) errors.push("year");
  }
  if (body.consent !== true) errors.push("consent");
  if (!/^[a-zA-Z0-9-]{10,100}$/.test(text(body.event_id, 101))) errors.push("event_id");
  try { const source = new URL(body.event_source_url); if (source.protocol !== "https:" && source.hostname !== "localhost") errors.push("event_source_url"); } catch { errors.push("event_source_url"); }
  return [...new Set(errors)];
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redisCommand(command) {
  const config = redisConfig();
  if (!config) return null;
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error(`Redis returned ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error("Redis command failed");
  return payload.result;
}

function pruneMemory(now = Date.now()) {
  for (const [key, value] of memoryRateLimits) if (value.resetAt <= now) memoryRateLimits.delete(key);
  for (const [key, expiresAt] of memoryEvents) if (expiresAt <= now) memoryEvents.delete(key);
}

async function checkRateLimit(req) {
  const key = `lead:rate:${hash(clientIp(req)).slice(0, 32)}:${Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000))}`;
  if (redisConfig()) {
    const count = Number(await redisCommand(["INCR", key]));
    if (count === 1) await redisCommand(["EXPIRE", key, RATE_WINDOW_SECONDS]);
    return count <= RATE_LIMIT;
  }
  pruneMemory();
  const current = memoryRateLimits.get(key) || { count: 0, resetAt: Date.now() + RATE_WINDOW_SECONDS * 1000 };
  current.count += 1;
  memoryRateLimits.set(key, current);
  return current.count <= RATE_LIMIT;
}

async function claimEvent(eventId) {
  const key = `lead:event:${eventId}`;
  if (redisConfig()) return (await redisCommand(["SET", key, "processing", "EX", IDEMPOTENCY_SECONDS, "NX"])) === "OK";
  pruneMemory();
  if (memoryEvents.has(key)) return false;
  memoryEvents.set(key, Date.now() + IDEMPOTENCY_SECONDS * 1000);
  return true;
}

async function releaseEvent(eventId) {
  const key = `lead:event:${eventId}`;
  if (redisConfig()) await redisCommand(["DEL", key]);
  else memoryEvents.delete(key);
}

async function sendEmail(body) {
  if (!process.env.RESEND_API_KEY || !process.env.LEAD_TO_EMAIL || !process.env.LEAD_FROM_EMAIL) throw new Error("Lead delivery is not configured");
  const attribution = body.attribution || {};
  const rows = [
    ["Nombre", body.name], ["WhatsApp", body.phone], ["Localidad", body.location], ["Consulta", body.inquiryType],
    ["Vehículo", body.vehicle], ["Año", body.year], ...UTM_KEYS.map((key) => [key, attribution[key]])
  ].filter(([, value]) => value).map(([label, value]) => `<tr><th align="left">${htmlEscape(label)}</th><td>${htmlEscape(value)}</td></tr>`).join("");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `lead/${body.event_id}` },
    body: JSON.stringify({ from: process.env.LEAD_FROM_EMAIL, to: [process.env.LEAD_TO_EMAIL], reply_to: process.env.LEAD_REPLY_TO || undefined, subject: `Nueva consulta: ${text(body.inquiryType, 30)}`, html: `<h1>Nueva consulta desde ME Seguros</h1><table cellpadding="7">${rows}</table><p>Consentimiento de contacto: sí · ${new Date().toISOString()}</p>` })
  });
  if (!response.ok) throw new Error(`Delivery provider returned ${response.status}`);
}

async function sendCapi(body, req) {
  if (!body.analytics_consent || !process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return false;
  const nameParts = normalize(body.name).split(/\s+/).filter(Boolean);
  const attribution = body.attribution || {};
  const fbc = text(body.fbc, 250) || (attribution.fbclid ? `fb.1.${Date.now()}.${text(attribution.fbclid, 200)}` : undefined);
  const userData = {
    ph: [hash(normalizePhone(body.phone))],
    fn: nameParts[0] ? [hash(nameParts[0])] : undefined,
    ln: nameParts.length > 1 ? [hash(nameParts.slice(1).join(""))] : undefined,
    ct: body.location ? [hash(normalize(body.location).replace(/[^a-z0-9]/g, ""))] : undefined,
    country: [hash("ar")], client_ip_address: clientIp(req) || undefined,
    client_user_agent: text(req.headers["user-agent"], 500) || undefined,
    fbp: text(body.fbp, 250) || undefined, fbc
  };
  Object.keys(userData).forEach((key) => userData[key] === undefined && delete userData[key]);
  const event = { event_name: "Lead", event_time: Math.floor(Date.now() / 1000), event_id: text(body.event_id, 100), event_source_url: text(body.event_source_url, 500), action_source: "website", user_data: userData, custom_data: { content_name: text(body.inquiryType, 30), lead_type: "quote_form", utm_source: text(attribution.utm_source), utm_campaign: text(attribution.utm_campaign), utm_content: text(attribution.utm_content) } };
  const payload = { data: [event] };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  const url = `https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}/${process.env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) console.error("Meta CAPI request failed", response.status);
  return response.ok;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  const originAllowed = !req.headers.origin || Boolean(res.getHeader("Access-Control-Allow-Origin"));
  if (req.method === "OPTIONS") return originAllowed ? res.status(204).end() : res.status(403).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  if (!originAllowed) return res.status(403).json({ ok: false, error: "Origin not allowed" });
  if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) return res.status(413).json({ ok: false, error: "Solicitud demasiado grande" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ ok: false, error: "JSON inválido" }); }
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) return res.status(413).json({ ok: false, error: "Solicitud demasiado grande" });
  if (body.company) return res.status(200).json({ ok: true });
  const errors = validate(body);
  if (errors.length) return res.status(400).json({ ok: false, error: "Datos inválidos", fields: errors });
  try {
    if (!(await checkRateLimit(req))) return res.status(429).json({ ok: false, error: "Demasiados intentos. Probá nuevamente más tarde." });
    if (!(await claimEvent(body.event_id))) return res.status(200).json({ ok: true, duplicate: true });
    try {
      await sendEmail(body);
    } catch (error) {
      await releaseEvent(body.event_id).catch(() => {});
      throw error;
    }
    const capiSent = await sendCapi(body, req).catch((error) => { console.error("CAPI error", error.message); return false; });
    return res.status(200).json({ ok: true, capi_sent: capiSent });
  } catch (error) {
    console.error("Lead delivery error", error.message);
    return res.status(503).json({ ok: false, error: "No se pudo entregar la consulta" });
  }
};

module.exports._test = { validate, normalize, normalizePhone, checkRateLimit, claimEvent, releaseEvent, memoryRateLimits, memoryEvents };
