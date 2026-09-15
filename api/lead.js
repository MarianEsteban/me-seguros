const crypto = require("node:crypto");

const ALLOWED_TYPES = new Set(["automotor", "hogar", "comercio", "vida", "accidentes", "viajero", "general"]);
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];
const text = (value, max = 250) => String(value || "").trim().slice(0, max);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalize = (value) => text(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const normalizePhone = (value) => text(value).replace(/\D/g, "");
const htmlEscape = (value) => text(value, 500).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));

function setCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function validate(body) {
  const errors = [];
  if (text(body.name, 80).length < 2) errors.push("name");
  if (normalizePhone(body.phone).length < 8) errors.push("phone");
  if (text(body.location, 80).length < 2) errors.push("location");
  if (!ALLOWED_TYPES.has(body.inquiryType)) errors.push("inquiryType");
  if (body.inquiryType === "automotor") {
    const year = Number(body.year);
    if (!text(body.vehicle, 100) || !year || year < 1950 || year > new Date().getFullYear() + 1) errors.push("vehicle");
  }
  if (body.consent !== true) errors.push("consent");
  if (!/^[a-zA-Z0-9-]{10,100}$/.test(text(body.event_id, 100))) errors.push("event_id");
  try { const source = new URL(body.event_source_url); if (!/^https?:$/.test(source.protocol)) errors.push("event_source_url"); } catch { errors.push("event_source_url"); }
  return errors;
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
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.LEAD_FROM_EMAIL, to: [process.env.LEAD_TO_EMAIL], reply_to: process.env.LEAD_REPLY_TO || undefined, subject: `Nueva consulta: ${text(body.inquiryType, 30)}`, html: `<h1>Nueva consulta desde ME Seguros</h1><table cellpadding="7">${rows}</table><p>Consentimiento de contacto: sí · ${new Date().toISOString()}</p>` })
  });
  if (!response.ok) throw new Error(`Delivery provider returned ${response.status}`);
}

async function sendCapi(body, req) {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return false;
  const nameParts = normalize(body.name).split(/\s+/).filter(Boolean);
  const attribution = body.attribution || {};
  const fbc = text(body.fbc, 250) || (attribution.fbclid ? `fb.1.${Date.now()}.${text(attribution.fbclid, 200)}` : undefined);
  const userData = {
    ph: [hash(normalizePhone(body.phone))],
    fn: nameParts[0] ? [hash(nameParts[0])] : undefined,
    ln: nameParts.length > 1 ? [hash(nameParts.slice(1).join(""))] : undefined,
    ct: body.location ? [hash(normalize(body.location).replace(/[^a-z0-9]/g, ""))] : undefined,
    country: [hash("ar")],
    client_ip_address: text(req.headers["x-forwarded-for"]?.split(",")[0], 64) || undefined,
    client_user_agent: text(req.headers["user-agent"], 500) || undefined,
    fbp: text(body.fbp, 250) || undefined,
    fbc
  };
  Object.keys(userData).forEach((key) => userData[key] === undefined && delete userData[key]);
  const event = { event_name: "Lead", event_time: Math.floor(Date.now() / 1000), event_id: text(body.event_id, 100), event_source_url: text(body.event_source_url, 500), action_source: "website", user_data: userData, custom_data: { content_name: text(body.inquiryType, 30), lead_type: "quote_form", utm_source: text(attribution.utm_source), utm_campaign: text(attribution.utm_campaign), utm_content: text(attribution.utm_content) } };
  const payload = { data: [event] };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  const url = `https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}/${process.env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) console.error("Meta CAPI request failed", response.status, await response.text());
  return response.ok;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  if (req.headers.origin && !res.getHeader("Access-Control-Allow-Origin")) return res.status(403).json({ ok: false, error: "Origin not allowed" });
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ ok: false, error: "JSON inválido" }); }
  if (body.company) return res.status(200).json({ ok: true });
  const errors = validate(body);
  if (errors.length) return res.status(400).json({ ok: false, error: "Datos inválidos", fields: errors });
  try {
    await sendEmail(body);
    const capiSent = await sendCapi(body, req).catch((error) => { console.error("CAPI error", error.message); return false; });
    return res.status(200).json({ ok: true, capi_sent: capiSent });
  } catch (error) {
    console.error("Lead delivery error", error.message);
    return res.status(503).json({ ok: false, error: "No se pudo entregar la consulta" });
  }
};

module.exports._test = { validate, normalize, normalizePhone };
