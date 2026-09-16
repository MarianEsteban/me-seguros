(() => {
  "use strict";
  const CONFIG = window.ME_CONFIG || {};
  const { validateLead } = window.MEValidation;
  const WHATSAPP = "5492291515617";
  const ATTR_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];
  const messages = {
    automotor: "Hola Mariano, quiero cotizar un seguro automotor. Mi vehículo es: ", hogar: "Hola Mariano, quiero consultar por un seguro de hogar.",
    comercio: "Hola Mariano, quiero consultar por un seguro para mi comercio.", vida: "Hola Mariano, quiero consultar por un seguro de vida.",
    accidentes: "Hola Mariano, quiero consultar por accidentes personales.", viajero: "Hola Mariano, quiero consultar por asistencia al viajero.",
    "lead-followup": "Hola Mariano, acabo de enviar el formulario de cotización y quiero continuar la consulta.", general: "Hola Mariano, quiero revisar mi seguro y consultar opciones."
  };
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* privacidad del navegador */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* privacidad del navegador */ } }
  };
  const uuid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const cookie = (name) => document.cookie.split("; ").find((item) => item.startsWith(`${name}=`))?.split("=").slice(1).join("=") || "";
  let currentEventId = uuid();
  let pixelReady = false;
  let viewContentPending = false;
  let viewContentSent = false;
  let consent = storage.get("me_analytics_consent");
  consent = consent === "granted" ? true : consent === "denied" ? false : null;

  function attributionSnapshot() {
    if (consent !== true) return {};
    const params = new URLSearchParams(location.search);
    const touch = { url: location.href, captured_at: new Date().toISOString() };
    ATTR_KEYS.forEach((key) => { if (params.get(key)) touch[key] = params.get(key).slice(0, 250); });
    let stored = {};
    try { stored = JSON.parse(storage.get("me_attribution") || "{}"); } catch { /* dato local inválido */ }
    stored.first_touch ||= touch;
    stored.last_touch = touch;
    storage.set("me_attribution", JSON.stringify(stored));
    return stored;
  }

  function initPixel() {
    if (pixelReady || consent !== true || !/^\d{5,20}$/.test(CONFIG.META_PIXEL_ID || "")) return;
    const fbq = window.fbq = function () { fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments); };
    fbq.push = fbq; fbq.loaded = true; fbq.version = "2.0"; fbq.queue = [];
    const script = document.createElement("script"); script.async = true; script.src = "https://connect.facebook.net/en_US/fbevents.js"; document.head.appendChild(script);
    fbq("init", CONFIG.META_PIXEL_ID); fbq("track", "PageView"); pixelReady = true;
    attributionSnapshot();
    if (viewContentPending && !viewContentSent) emitViewContent();
  }
  function track(name, data = {}, eventId) {
    if (!pixelReady || consent !== true) return;
    if (eventId) window.fbq("track", name, data, { eventID: eventId }); else window.fbq("track", name, data);
  }
  function emitViewContent() { if (consent === true && pixelReady && !viewContentSent) { track("ViewContent", { content_name: "Formulario de cotización" }); viewContentSent = true; viewContentPending = false; } }
  function markFormViewed() { if (viewContentSent) return; viewContentPending = true; if (consent === true) emitViewContent(); }
  function setConsent(value) {
    const previouslyGranted = consent === true;
    consent = value;
    storage.set("me_analytics_consent", value ? "granted" : "denied");
    document.querySelector("[name=analytics_consent]").checked = value;
    document.querySelector("#consent-banner").hidden = true;
    if (value) { if (pixelReady && !previouslyGranted) { attributionSnapshot(); track("PageView"); if (viewContentPending) emitViewContent(); } else initPixel(); }
    else { storage.remove("me_attribution"); ["_fbp", "_fbc"].forEach((name) => { document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`; }); }
  }

  const banner = document.querySelector("#consent-banner");
  if (consent === null) banner.hidden = false; else document.querySelector("[name=analytics_consent]").checked = consent;
  document.querySelector("[data-consent-accept]").addEventListener("click", () => setConsent(true));
  document.querySelector("[data-consent-reject]").addEventListener("click", () => setConsent(false));
  document.querySelector("[data-consent-settings]").addEventListener("click", () => { banner.hidden = false; banner.querySelector("button").focus(); });
  initPixel();

  document.querySelector("#current-year").textContent = new Date().getFullYear();
  const navToggle = document.querySelector(".nav-toggle"); const nav = document.querySelector(".nav");
  function closeMenu(returnFocus = false) { nav.classList.remove("open"); navToggle.setAttribute("aria-expanded", "false"); navToggle.querySelector(".sr-only").textContent = "Abrir menú"; document.body.classList.remove("menu-open"); if (returnFocus) navToggle.focus(); }
  navToggle.addEventListener("click", () => { const open = !nav.classList.contains("open"); if (open) { nav.classList.add("open"); navToggle.setAttribute("aria-expanded", "true"); navToggle.querySelector(".sr-only").textContent = "Cerrar menú"; document.body.classList.add("menu-open"); } else closeMenu(); });
  nav.addEventListener("click", (event) => { if (event.target.matches("a")) closeMenu(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && nav.classList.contains("open")) closeMenu(true); });

  const form = document.querySelector("#lead-form"); const type = document.querySelector("#inquiryType"); const vehicleFields = document.querySelector("#vehicle-fields");
  function toggleVehicle() { const shown = type.value === "automotor"; vehicleFields.classList.toggle("visible", shown); vehicleFields.hidden = !shown; vehicleFields.querySelectorAll("input").forEach((input) => { input.disabled = !shown; input.required = shown; }); }
  type.addEventListener("change", toggleVehicle); toggleVehicle();
  document.querySelectorAll(".js-view-form").forEach((link) => link.addEventListener("click", markFormViewed));
  document.querySelectorAll(".js-quote-type").forEach((link) => link.addEventListener("click", () => { type.value = link.dataset.type; toggleVehicle(); markFormViewed(); setTimeout(() => type.focus(), 350); }));
  new IntersectionObserver((entries, observer) => { if (entries.some((entry) => entry.isIntersecting)) { markFormViewed(); observer.disconnect(); } }, { threshold: 0.25 }).observe(form);
  document.querySelectorAll(".js-whatsapp").forEach((link) => { const context = link.dataset.context || "general"; link.href = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(messages[context] || messages.general)}`; link.addEventListener("click", () => track("Contact", { content_name: context })); });

  function showErrors(errors) {
    form.querySelectorAll(".error").forEach((node) => { node.textContent = ""; });
    form.querySelectorAll("[aria-invalid]").forEach((node) => node.removeAttribute("aria-invalid"));
    Object.entries(errors).forEach(([name, message]) => { document.querySelector(`#${name}-error`).textContent = message; form.elements[name]?.setAttribute("aria-invalid", "true"); });
    form.elements[Object.keys(errors)[0]]?.focus();
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form)); values.consent = form.elements.consent.checked;
    const errors = validateLead(values); showErrors(errors); if (Object.keys(errors).length) return;
    const wantsAnalytics = form.elements.analytics_consent.checked === true;
    if (wantsAnalytics !== consent) setConsent(wantsAnalytics);
    const attribution = attributionSnapshot();
    const payload = { ...values, consent: true, analytics_consent: wantsAnalytics, event_id: currentEventId, event_source_url: location.href, converted_at: new Date().toISOString(), attribution,
      fbp: wantsAnalytics ? cookie("_fbp") : "", fbc: wantsAnalytics ? (cookie("_fbc") || (attribution.first_touch?.fbclid ? `fb.1.${Date.parse(attribution.first_touch.captured_at)}.${attribution.first_touch.fbclid}` : "")) : "" };
    const button = form.querySelector("[type=submit]"); const status = document.querySelector("#form-status"); button.disabled = true; button.textContent = "Enviando…"; status.classList.remove("visible");
    try {
      const response = await fetch("/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.lead_received !== true) throw new Error(result.retryable ? "No pudimos confirmar la entrega. Reintentá: conservaremos la misma consulta para evitar duplicados." : "Revisá los datos e intentá nuevamente.");
      if (wantsAnalytics) track("Lead", { content_name: type.value }, currentEventId);
      form.hidden = true; const success = document.querySelector("#success-panel"); success.hidden = false; success.focus();
    } catch (error) { status.textContent = error.message || "No pudimos entregar la consulta. Intentá nuevamente o usá WhatsApp."; status.classList.add("visible"); }
    finally { button.disabled = false; button.textContent = "Solicitar cotización"; }
  });
  document.querySelector("#new-inquiry").addEventListener("click", () => { currentEventId = uuid(); form.reset(); form.elements.analytics_consent.checked = consent === true; toggleVehicle(); form.hidden = false; document.querySelector("#success-panel").hidden = true; document.querySelector("#name").focus(); });

  const dialog = document.querySelector("#privacy-dialog"); let dialogTrigger;
  document.querySelectorAll("[data-modal-open]").forEach((button) => button.addEventListener("click", () => { dialogTrigger = button; dialog.showModal(); }));
  document.querySelector("[data-modal-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => dialogTrigger?.focus());
})();
