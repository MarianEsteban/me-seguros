# ME Seguros — landing de performance

Landing mobile-first para el funnel **Meta Ads → landing → lead/WhatsApp → cotización → cierre** de Mariano Esteban, Productor Asesor de Seguros (matrícula N.º 87555).

## Qué se implementó

- Propuesta de valor y CTA de cotización visibles en el primer pantallazo.
- Coberturas con mensajes de WhatsApp específicos para automotor, hogar, comercio, vida, accidentes personales, asistencia al viajero y consulta general.
- Formulario breve tradicional (mejor que uno progresivo para solo seis datos): vehículo y año aparecen únicamente en automotor.
- Entrega real del lead por email mediante Resend. **El frontend solo confirma si el servidor confirma la entrega**; sin backend configurado muestra un error y ofrece WhatsApp.
- Persistencia local de UTM y `fbclid` únicamente después de que la persona acepta el tratamiento al enviar el formulario, y asociación de atribución al email y al evento server-side.
- Meta Pixel configurable y endpoint Vercel para Conversions API (CAPI), sin secretos en el navegador.
- Consentimiento, aviso de privacidad, honeypot, validación cliente/servidor, semántica y navegación accesible.

## Arquitectura

El HTML/CSS/JS sigue siendo la opción más simple y rápida: no hace falta un framework para esta landing. GitHub Pages sirve el frontend y una Vercel Function recibe `POST /api/lead`.

1. El navegador mantiene la atribución de la visita en memoria. Solo al aceptar y enviar el formulario la conserva en `localStorage`, inicia el Pixel configurado y obtiene `_fbp`/`_fbc` si existen; antes del consentimiento no almacena identificadores publicitarios.
2. Al enviar, genera un `event_id` único y manda datos, atribución e identificadores permitidos a Vercel.
3. La función valida los datos y entrega el lead por Resend.
4. Solo después de esa entrega envía `Lead` a CAPI. Normaliza y hashea con SHA-256 teléfono, nombre, apellido, localidad y país **en servidor**.
5. Ante respuesta exitosa, el navegador dispara `Lead` con el mismo `event_id`. Meta puede deduplicar browser + server.
6. Si CAPI falla pero el email se entregó, el lead se confirma y se registra el error en Vercel. Si el email falla, no se dispara `Lead` ni se muestra una confirmación falsa.

### Eventos

| Evento | Momento | Canal |
| --- | --- | --- |
| `PageView` | carga, una vez | Pixel |
| `ViewContent` | primera vista/interacción con el formulario | Pixel |
| `Contact` | clic en cualquier CTA de WhatsApp, con contexto | Pixel |
| `Lead` | entrega real del formulario | Pixel + CAPI, mismo `event_id` |

Los clics de WhatsApp no se envían a CAPI porque abrir una app externa no confirma que el mensaje se haya enviado. `Contact` en Pixel mide correctamente el clic relevante sin inflar `Lead`.

## Configuración pública del frontend

Editar `js/config.js`:

```js
window.ME_CONFIG = Object.freeze({
  META_PIXEL_ID: "", // Completar en el despliegue con el ID numérico validado.
  API_BASE_URL: "https://tu-proyecto.vercel.app",
  META_TEST_EVENT_CODE: ""
});
```

`META_PIXEL_ID` no es secreto. `API_BASE_URL` puede quedar vacío si frontend y API se sirven en el mismo despliegue de Vercel. No agregar tokens a este archivo.

## Variables secretas en Vercel

Copiar `.env.example` en la configuración del proyecto, no en Git:

- `RESEND_API_KEY`: API key de Resend.
- `LEAD_TO_EMAIL`: casilla real donde Mariano recibirá leads.
- `LEAD_FROM_EMAIL`: remitente de un dominio validado en Resend.
- `LEAD_REPLY_TO`: casilla de respuesta (opcional).
- `ALLOWED_ORIGINS`: orígenes exactos separados por coma, por ejemplo `https://marianesteban.github.io,https://www.meseguros.com.ar`. Un origin no lleva ruta.
- `META_PIXEL_ID`: ID real del dataset/píxel.
- `META_ACCESS_TOKEN`: token de CAPI; **solo Vercel**.
- `META_API_VERSION`: versión de Graph API que se haya validado al desplegar.
- `META_TEST_EVENT_CODE`: código temporal de “Probar eventos”; eliminar luego.

> No hay credenciales reales en el repositorio. La versión de Graph API debe revisarse periódicamente contra la documentación vigente de Meta.

## Desarrollo y pruebas

Requiere Node.js 20 o superior.

```bash
npm test
npm run check
python3 -m http.server 8000
```

Para probar el flujo real, instalar Vercel CLI, crear `.env.local` (ignorado por Git) y ejecutar `vercel dev`. Nunca usar una API key productiva en un archivo versionado.

## Despliegue

### Recomendado: todo en Vercel

1. Importar el repositorio en Vercel.
2. Configurar todas las variables anteriores para Production/Preview.
3. Verificar el dominio remitente en Resend.
4. Desplegar y dejar `API_BASE_URL: ""` si página y función comparten dominio.
5. Agregar el dominio final a `ALLOWED_ORIGINS`, actualizar canonical/OG/Schema en `index.html` y desplegar otra vez.

### GitHub Pages + API en Vercel

1. Desplegar este repositorio también en Vercel para disponer de `/api/lead`.
2. En `js/config.js`, apuntar `API_BASE_URL` al dominio HTTPS de Vercel.
3. Configurar `ALLOWED_ORIGINS=https://marianesteban.github.io` en Vercel.
4. Publicar la rama principal desde Settings → Pages.
5. Probar un lead real desde la URL pública y confirmar recepción del email.

## Configuración en Meta Events Manager

1. Crear o elegir el dataset/píxel de ME Seguros y copiar su ID a frontend y Vercel.
2. Generar un token de Conversions API y guardarlo únicamente como `META_ACCESS_TOKEN` en Vercel.
3. Usar “Probar eventos”, completar temporalmente `META_TEST_EVENT_CODE` y enviar un formulario real.
4. Confirmar `PageView`, `ViewContent`, `Contact` y un `Lead` browser/server deduplicado por `event_id`.
5. Revisar Diagnóstico y calidad de coincidencia. El lead envía teléfono, nombre, apellido, ciudad y país hasheados, además de IP/user-agent y `fbp`/`fbc` cuando existen.
6. Quitar `META_TEST_EVENT_CODE`, verificar el dominio, priorizar `Lead` si la configuración publicitaria lo requiere y crear audiencias de visitantes, vistas del formulario y contactos.
7. Verificar en campañas que las UTM estén completas; usar nombres consistentes para campaña, conjunto/anuncio y creatividad.

## Auditoría inicial resumida

La versión anterior era institucional y extensa: el CTA principal conducía directamente a WhatsApp, no había formulario ni entrega de leads, atribución, Pixel o CAPI. Había contenido repetido entre asesor/nosotros/proceso, cinco pasos largos, métricas visuales (“6+”, “1:1”) sin valor de conversión, imagen de logo de 1024×1024 servida a 52–60 px, dependencia de Google Fonts y enlaces de WhatsApp hardcodeados sin tracking. El acordeón no relacionaba controles/paneles mediante IDs. Tampoco existían consentimiento, aviso de privacidad, manejo de error de entrega ni backend.

La revisión llevó a: jerarquía orientada a intención, CTA primario al formulario, WhatsApp alternativo y contextual, menos contenido, tres pasos, CSS con fuentes del sistema, dimensiones explícitas, una sola imagen above-the-fold y JS diferido. La pieza `mariano-seguros-blanco 3.png` no se usa porque es una marca horizontal pequeña, no una fotografía real del asesor; no se inventó presencia visual ni prueba social.

## Pendientes que requieren datos o validación real

- ID de Pixel, token CAPI, casillas de email, API key y dominio verificado de Resend.
- Dominio definitivo; al tenerlo, actualizar canonical, OG, Schema y orígenes.
- Foto profesional real de Mariano, si decide incorporarla. No se usó stock.
- Horarios/canales formales de atención y plazo de conservación de leads.
- Validación por Mariano —y, de ser necesario, por un profesional legal argentino— del aviso de privacidad, el plazo operativo de conservación y el canal formal para ejercer derechos. El texto público es informativo y no reemplaza asesoramiento legal.
- Definición operativa de estados posteriores (cotizado/cerrado). Para optimizar a ventas, conviene que un CRM envíe luego eventos offline con su propio `event_id`.

## Checklist antes de lanzar campañas

- [ ] Formulario entrega un email real y la respuesta llega a Mariano.
- [ ] Todos los CTA abren el mensaje contextual correcto en Android/iOS.
- [ ] Events Manager recibe y deduplica `Lead` de Pixel/CAPI.
- [ ] `META_TEST_EVENT_CODE` fue eliminado.
- [ ] UTM y `fbclid` aparecen en el email de prueba.
- [ ] Dominio, canonical, OG y Schema coinciden.
- [ ] Aviso de privacidad, retención y contacto para derechos fueron validados.
- [ ] Página 404/errores, consola, mobile real y navegadores principales revisados.
- [ ] Campaña usa una conversión `Lead` coherente y no confunde `Contact` con un mensaje efectivamente enviado.
- [ ] Existe un proceso para responder rápido, registrar cotización y cierre.
