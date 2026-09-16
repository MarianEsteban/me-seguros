(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MEValidation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function normalizeArgentinePhone(value) {
    let digits = String(value || "").replace(/\D/g, "").replace(/^00/, "");
    if (digits.startsWith("54")) digits = digits.slice(2);
    if (digits.startsWith("9") && digits.length === 11) digits = digits.slice(1);
    if (digits.startsWith("0")) digits = digits.slice(1);
    if (digits.length === 12) {
      const marker = digits.indexOf("15", 2);
      if (marker >= 2 && marker <= 4) digits = digits.slice(0, marker) + digits.slice(marker + 2);
    }
    return digits.length === 10 ? `549${digits}` : "";
  }
  function validateLead(data, currentYear = new Date().getFullYear()) {
    const errors = {};
    if (String(data.name || "").trim().split(/\s+/).length < 2) errors.name = "Ingresá nombre y apellido.";
    if (!normalizeArgentinePhone(data.phone)) errors.phone = "Ingresá un WhatsApp argentino válido con código de área.";
    if (String(data.location || "").trim().length < 2) errors.location = "Ingresá tu localidad.";
    if (!data.inquiryType) errors.inquiryType = "Elegí un tipo de consulta.";
    if (data.inquiryType === "automotor") {
      if (String(data.vehicle || "").trim().length < 2) errors.vehicle = "Ingresá marca y modelo.";
      const year = Number(data.year);
      if (!Number.isInteger(year) || year < 1950 || year > currentYear + 1) errors.year = "Ingresá un año válido.";
    }
    if (data.consent !== true) errors.consent = "Necesitamos tu autorización para responder la consulta.";
    return errors;
  }
  return { normalizeArgentinePhone, validateLead };
});
