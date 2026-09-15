(() => {
  "use strict";

  const CONFIG = window.ME_CONFIG || {};
  const WHATSAPP = "5492291515617";
  const ATTRIBUTION_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];
  const messages = {
    automotor: "Hola Mariano, quiero cotizar un seguro automotor. Mi vehículo es: ",
    hogar: "Hola Mariano, quiero consultar por un seguro de hogar.",
    comercio: "Hola Mariano, quiero consultar por un seguro para mi comercio.",
    vida: "Hola Mariano, quiero consultar por un seguro de vida.",
    accidentes: "Hola Mariano, quiero consultar por accidentes personales.",
    viajero: "Hola Mariano, quiero consultar por asistencia al viajero.",
    "lead-followup": "Hola Mariano, acabo de enviar el formulario de cotización y quiero continuar la consulta.",
    general: "Hola Mariano, quiero revisar mi seguro y consultar opciones."
  };

  const safeStorage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* Storage puede estar bloqueado. */ } }
  };
  const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const getCookie = (name) => document.cookie.split("; ").find((item) => item.startsWith(`${name}=`))?.split("=").slice(1).join("=") || "";

  function readAttribution() {
    const params = new URLSearchParams(location.search);
    const stored = JSON.parse(safeStorage.get("me_attribution") || "{}");
    ATTRIBUTION_KEYS.forEach((key) => { if (params.get(key)) stored[key] = params.get(key).slice(0, 250); });
    stored.landing_page ||= location.href;
    stored.first_seen_at ||= new Date().toISOString();
    return stored;
  }

  function persistAttribution(attribution) {
    safeStorage.set("me_attribution", JSON.stringify(attribution));
  }

  function initPixel() {
    if (!CONFIG.META_PIXEL_ID || !/^\d{5,20}$/.test(CONFIG.META_PIXEL_ID)) return;
    if (window.fbq) return;
    const fbq = window.fbq = function () { fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments); };
    fbq.push = fbq; fbq.loaded = true; fbq.version = "2.0"; fbq.queue = [];
    const script = document.createElement("script"); script.async = true; script.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(script);
    fbq("init", CONFIG.META_PIXEL_ID);
    fbq("track", "PageView");
  }

  function track(name, parameters = {}, eventId) {
    if (!window.fbq) return;
    if (eventId) window.fbq("track", name, parameters, { eventID: eventId });
    else window.fbq("track", name, parameters);
  }

  // La atribución se mantiene en memoria hasta que la persona acepta el tratamiento
  // al enviar el formulario. No se escriben identificadores publicitarios antes.
  const attribution = readAttribution();
  document.querySelector("#current-year").textContent = new Date().getFullYear();

  const navToggle = document.querySelector(".nav-toggle");
  const nav = document.querySelector(".nav");
  function setMenuOpen(open, returnFocus = false) {
    nav.classList.toggle("open", open);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.querySelector(".sr-only").textContent = open ? "Cerrar menú" : "Abrir menú";
    document.body.classList.toggle("menu-open", open);
    if (returnFocus) navToggle.focus();
  }
  navToggle?.addEventListener("click", () => {
    const open = !nav.classList.contains("open");
    setMenuOpen(open);
  });
  nav?.addEventListener("click", (event) => { if (event.target.matches("a")) setMenuOpen(false); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.classList.contains("open")) setMenuOpen(false, true);
  });

  document.querySelectorAll(".js-whatsapp").forEach((link) => {
    const context = link.dataset.context || "general";
    link.href = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(messages[context] || messages.general)}`;
    link.addEventListener("click", () => track("Contact", { content_name: `whatsapp_${context}`, contact_method: "whatsapp" }));
  });

  let viewedQuote = false;
  const markQuoteView = (source) => { if (!viewedQuote) { viewedQuote = true; track("ViewContent", { content_name: "formulario_cotizacion", source }); } };
  document.querySelectorAll(".js-view-form").forEach((link) => link.addEventListener("click", () => markQuoteView("cta")));

  const form = document.querySelector("#lead-form");
  const inquiryType = document.querySelector("#inquiryType");
  const vehicleFields = document.querySelector("#vehicle-fields");
  const formStatus = document.querySelector("#form-status");
  const successPanel = document.querySelector("#success-panel");

  const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { markQuoteView("scroll"); observer.disconnect(); } }, { threshold: .45 });
  observer.observe(form);

  function updateVehicleFields() {
    const isVehicle = inquiryType.value === "automotor";
    vehicleFields.classList.toggle("visible", isVehicle);
    ["vehicle", "year"].forEach((name) => { form.elements[name].required = isVehicle; });
  }
  inquiryType.addEventListener("change", updateVehicleFields);
  document.querySelectorAll(".js-quote-type").forEach((link) => link.addEventListener("click", () => { inquiryType.value = link.dataset.type; updateVehicleFields(); markQuoteView("coverage"); }));

  function validate() {
    form.querySelectorAll(".error").forEach((node) => { node.textContent = ""; });
    form.querySelectorAll("[aria-invalid]").forEach((node) => node.removeAttribute("aria-invalid"));
    const errors = {};
    const data = new FormData(form);
    if ((data.get("name") || "").trim().length < 2) errors.name = "Ingresá tu nombre.";
    if ((data.get("phone") || "").replace(/\D/g, "").length < 8) errors.phone = "Ingresá un WhatsApp válido.";
    if ((data.get("location") || "").trim().length < 2) errors.location = "Ingresá tu localidad.";
    if (!data.get("inquiryType")) errors.inquiryType = "Elegí el tipo de consulta.";
    if (data.get("inquiryType") === "automotor") {
      if (!(data.get("vehicle") || "").trim()) errors.vehicle = "Ingresá marca y modelo.";
      const year = Number(data.get("year")); if (!year || year < 1950 || year > new Date().getFullYear() + 1) errors.year = "Ingresá un año válido.";
    }
    if (!data.get("consent")) errors.consent = "Necesitamos tu autorización para contactarte.";
    Object.entries(errors).forEach(([field, message]) => { document.querySelector(`#${field}-error`).textContent = message; form.elements[field]?.setAttribute("aria-invalid", "true"); });
    form.elements[Object.keys(errors)[0]]?.focus();
    return Object.keys(errors).length === 0;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formStatus.classList.remove("visible");
    if (!validate()) return;
    if (!CONFIG.API_BASE_URL && location.hostname.endsWith("github.io")) {
      formStatus.textContent = "El formulario todavía no está conectado al servidor. Podés continuar por WhatsApp.";
      formStatus.classList.add("visible"); return;
    }
    persistAttribution(attribution);
    initPixel();
    const submit = form.querySelector("[type=submit]"); submit.disabled = true; submit.textContent = "Enviando…";
    const data = Object.fromEntries(new FormData(form));
    const eventId = uuid();
    const payload = { ...data, consent: true, event_id: eventId, event_source_url: location.href, attribution, fbp: getCookie("_fbp"), fbc: getCookie("_fbc") };
    try {
      const endpoint = `${(CONFIG.API_BASE_URL || "").replace(/\/$/, "")}/api/lead`;
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "No se pudo enviar");
      track("Lead", { content_name: data.inquiryType, lead_type: "quote_form" }, eventId);
      form.hidden = true; successPanel.hidden = false; successPanel.focus();
    } catch {
      formStatus.textContent = "No pudimos enviar la consulta. Revisá tu conexión o escribinos por WhatsApp.";
      formStatus.classList.add("visible");
    } finally { submit.disabled = false; submit.textContent = "Solicitar cotización"; }
  });
  document.querySelector("#new-inquiry").addEventListener("click", () => { form.reset(); updateVehicleFields(); form.hidden = false; successPanel.hidden = true; form.querySelector("input").focus(); });

  const dialog = document.querySelector("#privacy-dialog");
  document.querySelectorAll("[data-modal-open]").forEach((button) => button.addEventListener("click", () => dialog.showModal()));
  document.querySelector("[data-modal-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
})();
