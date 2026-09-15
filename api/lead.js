const crypto = require("node:crypto");

const ALLOWED_TYPES = new Set(["automotor", "hogar", "comercio", "vida", "accidentes", "viajero", "general"]);
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];
const EVENT_ID = /^[a-zA-Z0-9-]{10,100}$/;
const TIMEOUTS = { redis: 1500, resend: 5000, capi: 5000 };
const memory = new Map();
const text = (value, max = 250) => String(value || "").trim().slice(0, max);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalize = (value) => text(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

function normalizePhone(value) {
  let digits = text(value).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("54")) digits = digits.slice(2);
  digits = digits.replace(/^0+/, "");
  if (digits.startsWith("9") && digits.length >= 11) digits = digits.slice(1);
  const areaMatch = digits.match(/^(11|2\d{2,3}|3\d{2,3})(15)(\d{6,8})$/);
  if (areaMatch) digits = `${areaMatch[1]}${areaMatch[3]}`;
  return digits.length >= 10 && digits.length <= 11 ? `549${digits}` : "";
}

const htmlEscape = (value) => text(value, 500).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
const allowedOrigins = () => (process.env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean);

function originAllowed(origin) {
  if (!origin) return true;
  try { return allowedOrigins().includes(new URL(origin).origin); } catch { return false; }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) res.setHeader("Access-Control-Allow-Origin", new URL(origin).origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function validate(body, requestOrigin = "") {
  const errors = [];
  if (text(body.name, 80).length < 2) errors.push("name");
  if (!normalizePhone(body.phone)) errors.push("phone");
  if (text(body.location, 80).length < 2) errors.push("location");
  if (!ALLOWED_TYPES.has(body.inquiryType)) errors.push("inquiryType");
  if (body.inquiryType === "automotor") {
    const year = Number(body.year);
    if (!text(body.vehicle, 100) || !year || year < 1950 || year > new Date().getFullYear() + 1) errors.push("vehicle");
  }
  if (body.consent !== true) errors.push("consent");
  if (!EVENT_ID.test(text(body.event_id, 100))) errors.push("event_id");
  try {
    const source = new URL(body.event_source_url);
    const expected = requestOrigin ? new URL(requestOrigin).origin : "";
    if (source.protocol !== "https:" || (!originAllowed(source.origin) && source.origin !== expected)) errors.push("event_source_url");
  } catch { errors.push("event_source_url"); }
  return errors;
}

async function timedFetch(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function redis(command) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const response = await timedFetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) }, TIMEOUTS.redis);
  if (!response.ok) throw new Error(`Redis returned ${response.status}`);
  return (await response.json()).result;
}

async function rateLimit(key, limit = 5, windowSeconds = 600) {
  const bucket = `rate:${key}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
  const remote = await redis(["INCR", bucket]);
  if (remote !== null) {
    if (Number(remote) === 1) await redis(["EXPIRE", bucket, windowSeconds]);
    return Number(remote) <= limit;
  }
  const current = memory.get(bucket) || 0;
  memory.set(bucket, current + 1);
  return current < limit;
}

async function claimEvent(eventId) {
  const key = `lead:${eventId}`;
  const result = await redis(["SET", key, "processing", "NX", "EX", 86400]);
  if (result !== null) return result === "OK";
  if (memory.has(key)) return false;
  memory.set(key, "processing");
  return true;
}

async function eventState(eventId) {
  const key = `lead:${eventId}`;
  return (await redis(["GET", key])) || memory.get(key);
}

async function saveEvent(eventId, state) {
  const key = `lead:${eventId}`;
  memory.set(key, state);
  await redis(["SET", key, state, "EX", 86400]);
}

async function sendEmail(body) {
  if (!process.env.RESEND_API_KEY || !process.env.LEAD_TO_EMAIL || !process.env.LEAD_FROM_EMAIL) throw new Error("Lead delivery is not configured");
  const attribution = body.attribution || {};
  const touches = [["Primera visita", attribution.first_touch], ["Última visita", attribution.last_touch]];
  const rows = [["Nombre", body.name], ["WhatsApp", normalizePhone(body.phone)], ["Localidad", body.location], ["Consulta", body.inquiryType], ["Vehículo", body.vehicle], ["Año", body.year], ...UTM_KEYS.map((key) => [key, attribution.last_touch?.[key] || attribution[key]]), ...touches]
    .filter(([, value]) => value).map(([label, value]) => `<tr><th align="left">${htmlEscape(label)}</th><td>${htmlEscape(typeof value === "object" ? JSON.stringify(value) : value)}</td></tr>`).join("");
  const response = await timedFetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": body.event_id }, body: JSON.stringify({ from: process.env.LEAD_FROM_EMAIL, to: [process.env.LEAD_TO_EMAIL], reply_to: process.env.LEAD_REPLY_TO || undefined, subject: `Nueva consulta: ${text(body.inquiryType, 30)}`, html: `<h1>Nueva consulta desde ME Seguros</h1><table cellpadding="7">${rows}</table><p>Consentimiento de contacto: sí · ${new Date().toISOString()}</p>` }) }, TIMEOUTS.resend);
  if (!response.ok) throw new Error(`Delivery provider returned ${response.status}`);
}

async function sendCapi(body, req) {
  if (!body.tracking_consent || !process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return false;
  const nameParts = normalize(body.name).split(/\s+/).filter(Boolean);
  const attribution = body.attribution?.last_touch || body.attribution || {};
  const fbc = text(body.fbc, 250) || (attribution.fbclid ? `fb.1.${Date.now()}.${text(attribution.fbclid, 200)}` : undefined);
  const userData = { ph: [hash(normalizePhone(body.phone))], fn: nameParts[0] ? [hash(nameParts[0])] : undefined, ln: nameParts.length > 1 ? [hash(nameParts.slice(1).join(""))] : undefined, ct: body.location ? [hash(normalize(body.location).replace(/[^a-z0-9]/g, ""))] : undefined, country: [hash("ar")], client_ip_address: text(req.headers["x-forwarded-for"]?.split(",")[0], 64) || undefined, client_user_agent: text(req.headers["user-agent"], 500) || undefined, fbp: text(body.fbp, 250) || undefined, fbc };
  Object.keys(userData).forEach((key) => userData[key] === undefined && delete userData[key]);
  const payload = { data: [{ event_name: "Lead", event_time: Math.floor(Date.now() / 1000), event_id: text(body.event_id, 100), event_source_url: text(body.event_source_url, 500), action_source: "website", user_data: userData, custom_data: { content_name: text(body.inquiryType, 30), lead_type: "quote_form", utm_source: text(attribution.utm_source), utm_campaign: text(attribution.utm_campaign), utm_content: text(attribution.utm_content) } }] };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  const url = `https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}/${process.env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const response = await timedFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, TIMEOUTS.capi);
  if (!response.ok) throw new Error(`Meta CAPI returned ${response.status}`);
  return true;
}

async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  if (req.headers.origin && !originAllowed(req.headers.origin)) return res.status(403).json({ ok: false, error: "Origin not allowed" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { return res.status(400).json({ ok: false, error: "JSON inválido" }); }
  if (body.company) return res.status(202).json({ ok: true, lead_received: false });
  if (Number(body.form_elapsed_ms) < 1500) return res.status(400).json({ ok: false, error: "Solicitud inválida" });
  const errors = validate(body, req.headers.origin || `https://${req.headers.host || ""}`);
  if (errors.length) return res.status(400).json({ ok: false, error: "Datos inválidos", fields: errors });
  const ip = text(req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress, 64);
  try {
    if (!(await rateLimit(hash(ip || "unknown")))) return res.status(429).json({ ok: false, error: "Demasiados intentos. Probá nuevamente en unos minutos." });
    if (!(await claimEvent(body.event_id))) {
      const state = await eventState(body.event_id);
      if (state?.startsWith("delivered")) return res.status(200).json({ ok: true, lead_received: true, duplicate: true, capi_sent: state === "delivered:capi" });
      return res.status(409).json({ ok: false, retryable: true, error: "La consulta ya se está procesando" });
    }
  } catch (error) {
    console.error("Abuse protection error", error.message);
    return res.status(503).json({ ok: false, retryable: true, error: "Servicio temporalmente no disponible" });
  }
  try {
    await sendEmail(body);
    await saveEvent(body.event_id, "delivered");
  } catch (error) {
    console.error("Lead delivery error", error.message);
    await saveEvent(body.event_id, "failed").catch(() => {});
    return res.status(503).json({ ok: false, retryable: true, error: "No se pudo entregar la consulta" });
  }
  try {
    const capiSent = await sendCapi(body, req);
    await saveEvent(body.event_id, capiSent ? "delivered:capi" : "delivered");
    return res.status(200).json({ ok: true, lead_received: true, capi_sent: capiSent });
  } catch (error) {
    console.error("CAPI error after lead delivery", error.message);
    return res.status(200).json({ ok: true, lead_received: true, capi_sent: false, warning: "tracking_unavailable" });
  }
}

module.exports = handler;
module.exports._test = { validate, normalize, normalizePhone, originAllowed, rateLimit, claimEvent, eventState, saveEvent, handler, memory };
