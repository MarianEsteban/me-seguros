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
  const safeJson = (value, fallback = {}) => { try { return JSON.parse(value) || fallback; } catch { return fallback; } };
  const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const getCookie = (name) => document.cookie.split("; ").find((item) => item.startsWith(`${name}=`))?.split("=").slice(1).join("=") || "";

  function captureAttribution() {
    const params = new URLSearchParams(location.search);
    const stored = safeJson(safeStorage.get("me_attribution"));
    const touch = { landing_page: location.href, seen_at: new Date().toISOString() };
    ATTRIBUTION_KEYS.forEach((key) => { if (params.get(key)) touch[key] = params.get(key).slice(0, 250); });
    stored.first_touch ||= touch;
    stored.last_touch = touch;
    safeStorage.set("me_attribution", JSON.stringify(stored));
    return stored;
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

  const attribution = captureAttribution();
  let trackingConsent = safeStorage.get("me_tracking_consent") === "yes";
  if (trackingConsent) initPixel();
  document.querySelector("#current-year").textContent = new Date().getFullYear();

  const navToggle = document.querySelector(".nav-toggle");
  const nav = document.querySelector(".nav");
  navToggle?.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("menu-open", open);
  });
  nav?.addEventListener("click", (event) => { if (event.target.matches("a")) { nav.classList.remove("open"); navToggle.setAttribute("aria-expanded", "false"); document.body.classList.remove("menu-open"); } });

  document.querySelectorAll(".js-whatsapp").forEach((link) => {
    const context = link.dataset.context || "general";
    link.href = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(messages[context] || messages.general)}`;
    link.addEventListener("click", () => track("Contact", { content_name: `whatsapp_${context}`, contact_method: "whatsapp" }));
  });

  let viewedQuote = false;
  const markQuoteView = (source) => { if (!viewedQuote) { viewedQuote = true; track("ViewContent", { content_name: "formulario_cotizacion", source }); } };
  document.querySelectorAll(".js-view-form").forEach((link) => link.addEventListener("click", () => markQuoteView("cta")));

  const form = document.querySelector("#lead-form");
  const formStartedAt = Date.now();
  const inquiryType = document.querySelector("#inquiryType");
  const vehicleFields = document.querySelector("#vehicle-fields");
  const formStatus = document.querySelector("#form-status");
  const successPanel = document.querySelector("#success-panel");
  form.elements.year.max = String(new Date().getFullYear() + 1);

  const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { markQuoteView("scroll"); observer.disconnect(); } }, { threshold: .45 });
  observer.observe(form);

  function updateVehicleFields() {
    const isVehicle = inquiryType.value === "automotor";
    vehicleFields.classList.toggle("visible", isVehicle);
    ["vehicle", "year"].forEach((name) => { form.elements[name].required = isVehicle; });
  }
  inquiryType.addEventListener("change", updateVehicleFields);
  document.querySelectorAll(".js-quote-type").forEach((link) => link.addEventListener("click", () => { inquiryType.value = link.dataset.type; updateVehicleFields(); markQuoteView("coverage"); }));
  form.elements.tracking_consent?.addEventListener("change", (event) => {
    trackingConsent = event.target.checked;
    safeStorage.set("me_tracking_consent", trackingConsent ? "yes" : "no");
    if (trackingConsent) initPixel();
  });
  if (form.elements.tracking_consent) form.elements.tracking_consent.checked = trackingConsent;

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
    const submit = form.querySelector("[type=submit]"); submit.disabled = true; submit.textContent = "Enviando…";
    const data = Object.fromEntries(new FormData(form));
    const eventId = uuid();
    const payload = { ...data, consent: true, tracking_consent: trackingConsent, form_elapsed_ms: Date.now() - formStartedAt, event_id: eventId, event_source_url: location.href, attribution, fbp: getCookie("_fbp"), fbc: getCookie("_fbc") };
    try {
      const response = await fetch("/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "No se pudo enviar");
      if (trackingConsent) track("Lead", { content_name: data.inquiryType, lead_type: "quote_form" }, eventId);
      history.replaceState({}, "", "/?conversion=lead#cotizar");
      form.hidden = true; successPanel.hidden = false; successPanel.focus();
    } catch {
      formStatus.textContent = "No pudimos enviar la consulta. Revisá tu conexión o escribinos por WhatsApp.";
      formStatus.classList.add("visible");
    } finally { submit.disabled = false; submit.textContent = "Solicitar cotización"; }
  });
  document.querySelector("#new-inquiry").addEventListener("click", () => { form.reset(); updateVehicleFields(); form.hidden = false; successPanel.hidden = true; form.querySelector("input").focus(); });

  const dialog = document.querySelector("#privacy-dialog");
  let modalTrigger;
  document.querySelectorAll("[data-modal-open]").forEach((button) => button.addEventListener("click", () => { modalTrigger = button; dialog.showModal(); }));
  document.querySelector("[data-modal-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => modalTrigger?.focus());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
})();
