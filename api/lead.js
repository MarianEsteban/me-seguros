const crypto = require("node:crypto");

const ALLOWED_TYPES = new Set(["automotor", "hogar", "comercio", "vida", "accidentes", "viajero", "general"]);
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];
const TIMEOUTS = { redis: 2500, resend: 7000, capi: 5000 };
const text = (value, max = 250) => String(value || "").trim().slice(0, max);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalize = (value) => text(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const htmlEscape = (value) => text(value, 500).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));

// Meta espera teléfonos en E.164, sólo dígitos. En Argentina se quita el 0
// interurbano y el 15 local, y se agrega 549 para números móviles nacionales.
function normalizePhone(value) {
  let digits = text(value).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("54")) {
    digits = digits.slice(2).replace(/^0/, "");
    if (!digits.startsWith("9")) digits = `9${digits.replace(/^(\d{2,4})15/, "$1")}`;
    return `54${digits}`;
  }
  digits = digits.replace(/^0/, "").replace(/^(\d{2,4})15/, "$1");
  return digits.length === 10 ? `549${digits}` : digits;
}

function allowedOrigins() {
  const configured = (process.env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean);
  if (process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production") {
    configured.push("http://localhost:3000", "http://localhost:8000", "http://127.0.0.1:3000", "http://127.0.0.1:8000");
  }
  return new Set(configured);
}

function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && allowedOrigins().has(url.origin);
  } catch { return false; }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins().has(origin.replace(/\/$/, ""))) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function validate(body) {
  const errors = [];
  if (text(body.name, 80).length < 2) errors.push("name");
  if (normalizePhone(body.phone).length < 12) errors.push("phone");
  if (text(body.location, 80).length < 2) errors.push("location");
  if (!ALLOWED_TYPES.has(body.inquiryType)) errors.push("inquiryType");
  if (body.inquiryType === "automotor") {
    const year = Number(body.year);
    if (!text(body.vehicle, 100) || !year || year < 1950 || year > new Date().getFullYear() + 1) errors.push("vehicle");
  }
  if (body.consent !== true) errors.push("consent");
  if (!/^[a-zA-Z0-9-]{10,100}$/.test(text(body.event_id, 100))) errors.push("event_id");
  if (!isAllowedUrl(body.event_source_url)) errors.push("event_source_url");
  return errors;
}

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redis(command) {
  const config = redisConfig();
  if (!config) return null;
  const response = await fetchWithTimeout(config.url, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) }, TIMEOUTS.redis);
  if (!response.ok) throw new Error(`Redis returned ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error);
  return payload.result;
}

async function checkRateLimit(req) {
  if (!redisConfig()) return true;
  const ip = text(req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "unknown", 64);
  const bucket = Math.floor(Date.now() / 60000);
  const key = `rate:lead:${hash(ip).slice(0, 24)}:${bucket}`;
  const count = Number(await redis(["INCR", key]));
  if (count === 1) await redis(["EXPIRE", key, 120]);
  return count <= Number(process.env.RATE_LIMIT_PER_MINUTE || 10);
}

async function beginIdempotency(eventId) {
  if (!redisConfig()) return { state: null, acquired: true };
  const key = `lead:${eventId}`;
  const acquired = await redis(["SET", key, "processing", "NX", "EX", 86400]);
  return acquired ? { key, state: "processing", acquired: true } : { key, state: await redis(["GET", key]), acquired: false };
}

async function setState(key, state) { if (key) await redis(["SET", key, state, "EX", 86400]); }
async function clearState(key) { if (key) await redis(["DEL", key]); }

async function sendEmail(body) {
  if (!process.env.RESEND_API_KEY || !process.env.LEAD_TO_EMAIL || !process.env.LEAD_FROM_EMAIL) throw new Error("Lead delivery is not configured");
  const attribution = body.attribution || {};
  const touches = ["first_touch", "last_touch"].flatMap((touch) => UTM_KEYS.map((key) => [`${touch}.${key}`, attribution[touch]?.[key]]));
  const rows = [
    ["Nombre", body.name], ["WhatsApp", body.phone], ["Localidad", body.location], ["Consulta", body.inquiryType],
    ["Vehículo", body.vehicle], ["Año", body.year], ["URL de conversión", attribution.conversion_url || body.event_source_url],
    ["Fecha de conversión", attribution.converted_at], ...touches
  ].filter(([, value]) => value).map(([label, value]) => `<tr><th align="left">${htmlEscape(label)}</th><td>${htmlEscape(value)}</td></tr>`).join("");
  const response = await fetchWithTimeout("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.LEAD_FROM_EMAIL, to: [process.env.LEAD_TO_EMAIL], reply_to: process.env.LEAD_REPLY_TO || undefined, subject: `Nueva consulta: ${text(body.inquiryType, 30)}`, html: `<h1>Nueva consulta desde ME Seguros</h1><table cellpadding="7">${rows}</table><p>Consentimiento de contacto: sí · ${new Date().toISOString()}</p>` })
  }, TIMEOUTS.resend);
  if (!response.ok) throw new Error(`Delivery provider returned ${response.status}`);
}

async function sendCapi(body, req) {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return false;
  const nameParts = normalize(body.name).split(/\s+/).filter(Boolean);
  const attribution = body.attribution || {};
  const latest = attribution.last_touch || {};
  const fbc = text(body.fbc, 250) || (latest.fbclid ? `fb.1.${Date.now()}.${text(latest.fbclid, 200)}` : undefined);
  const userData = { ph: [hash(normalizePhone(body.phone))], fn: nameParts[0] ? [hash(nameParts[0])] : undefined, ln: nameParts.length > 1 ? [hash(nameParts.slice(1).join(""))] : undefined, ct: body.location ? [hash(normalize(body.location).replace(/[^a-z0-9]/g, ""))] : undefined, country: [hash("ar")], client_ip_address: text(req.headers["x-forwarded-for"]?.split(",")[0], 64) || undefined, client_user_agent: text(req.headers["user-agent"], 500) || undefined, fbp: text(body.fbp, 250) || undefined, fbc };
  Object.keys(userData).forEach((key) => userData[key] === undefined && delete userData[key]);
  const event = { event_name: "Lead", event_time: Math.floor(Date.now() / 1000), event_id: text(body.event_id, 100), event_source_url: text(body.event_source_url, 500), action_source: "website", user_data: userData, custom_data: { content_name: text(body.inquiryType, 30), lead_type: "quote_form", utm_source: text(latest.utm_source), utm_campaign: text(latest.utm_campaign), utm_content: text(latest.utm_content) } };
  const payload = { data: [event] };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  const url = `https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}/${process.env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const response = await fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, TIMEOUTS.capi);
  if (!response.ok) console.error("Meta CAPI request failed", response.status, await response.text());
  return response.ok;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  if (req.headers.origin && !res.getHeader("Access-Control-Allow-Origin")) return res.status(403).json({ ok: false, error: "Origin not allowed" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { return res.status(400).json({ ok: false, error: "JSON inválido" }); }
  if (body.company) return res.status(200).json({ ok: true, lead_received: true, capi_sent: false });
  const errors = validate(body);
  if (errors.length) return res.status(400).json({ ok: false, error: "Datos inválidos", fields: errors });
  try { if (!await checkRateLimit(req)) return res.status(429).json({ ok: false, error: "Demasiadas solicitudes" }); }
  catch (error) { console.error("Rate limit error", error.message); return res.status(503).json({ ok: false, error: "Servicio temporalmente no disponible" }); }
  let idem;
  try {
    idem = await beginIdempotency(body.event_id);
    if (!idem.acquired) {
      if (idem.state === "processing") return res.status(409).json({ ok: false, lead_received: false, capi_sent: false, status: "processing" });
      const delivered = idem.state === "delivered" || idem.state === "delivered:capi";
      return res.status(delivered ? 200 : 409).json({ ok: delivered, lead_received: delivered, capi_sent: idem.state === "delivered:capi", status: idem.state || "unknown" });
    }
    await sendEmail(body);
    await setState(idem.key, "delivered");
  } catch (error) {
    console.error("Lead delivery error", error.message);
    try { await clearState(idem?.key); } catch (cleanupError) { console.error("Idempotency cleanup error", cleanupError.message); }
    return res.status(503).json({ ok: false, lead_received: false, capi_sent: false, error: "No se pudo entregar la consulta" });
  }
  const capiSent = await sendCapi(body, req).catch((error) => { console.error("CAPI error", error.message); return false; });
  if (capiSent) { try { await setState(idem.key, "delivered:capi"); } catch (error) { console.error("CAPI state error", error.message); } }
  return res.status(200).json({ ok: true, lead_received: true, capi_sent: capiSent, status: capiSent ? "delivered:capi" : "delivered" });
};

module.exports._test = { validate, normalize, normalizePhone, isAllowedUrl, fetchWithTimeout };
