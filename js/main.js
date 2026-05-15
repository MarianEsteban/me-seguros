// ME Seguros - Interacciones simples para la landing page

document.addEventListener("DOMContentLoaded", () => {
  const navToggle = document.querySelector(".nav-toggle");
  const primaryNav = document.querySelector(".primary-nav");
  const navLinks = document.querySelectorAll(".primary-nav a");
  const faqButtons = document.querySelectorAll(".faq-question");
  const currentYear = document.querySelector("#current-year");
  const brandLogos = document.querySelectorAll(".brand-logo");

  // Si el logo todavía no está cargado en /img/logo-me-seguros.png, evita mostrar el ícono de imagen rota.
  brandLogos.forEach((logo) => {
    const showFallback = () => {
      logo.style.display = "none";
      const fallback = logo.nextElementSibling;
      if (fallback) {
        fallback.style.display = "inline";
      }
    };

    logo.addEventListener("error", showFallback);

    if (logo.complete && logo.naturalWidth === 0) {
      showFallback();
    }
  });

  // Actualiza automáticamente el año del footer.
  if (currentYear) {
    currentYear.textContent = new Date().getFullYear();
  }

  // Abre y cierra el menú mobile.
  if (navToggle && primaryNav) {
    navToggle.addEventListener("click", () => {
      const isOpen = primaryNav.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(isOpen));
    });
  }

  // Cierra el menú mobile cuando se elige una sección interna.
  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      primaryNav?.classList.remove("is-open");
      navToggle?.setAttribute("aria-expanded", "false");
    });
  });

  // Acordeón de preguntas frecuentes con estado accesible.
  faqButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const item = button.closest(".faq-item");
      const isOpen = item?.classList.toggle("is-open") ?? false;
      button.setAttribute("aria-expanded", String(isOpen));
    });
  });
});
