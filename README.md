# ME Seguros — landing de performance

Landing mobile-first para el funnel **Meta Ads → landing → lead/WhatsApp → cotización → cierre** de Mariano Esteban, Productor Asesor de Seguros (matrícula N.º 87555).

## Qué se implementó

- Propuesta de valor y CTA de cotización visibles en el primer pantallazo.
- Coberturas con mensajes de WhatsApp específicos para automotor, hogar, comercio, vida, accidentes personales, asistencia al viajero y consulta general.
- Formulario breve tradicional (mejor que uno progresivo para solo seis datos): vehículo y año aparecen únicamente en automotor.
- Entrega real del lead por email mediante Resend. **El frontend solo confirma si el servidor confirma la entrega**; sin backend configurado muestra un error y ofrece WhatsApp.
- Persistencia local de UTM y `fbclid`, y asociación de atribución al email y al evento server-side.
- Meta Pixel configurable y endpoint Vercel para Conversions API (CAPI), sin secretos en el navegador.
- Consentimiento de contacto, analítica opcional con preferencias, honeypot, validación cliente/servidor, semántica y navegación accesible.

## Arquitectura

El HTML/CSS/JS sigue siendo la opción más simple y rápida: no hace falta un framework para esta landing. Vercel sirve el frontend y la Function que recibe `POST /api/lead` bajo el mismo origen. GitHub se usa únicamente como repositorio.

1. El navegador conserva los parámetros de primera atribución en `localStorage` y obtiene `_fbp`/`_fbc` si existen.
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

Editar `js/config.js` únicamente para definir `META_PIXEL_ID` cuando se habilite la medición. El ID no es secreto; los tokens nunca deben publicarse. El frontend siempre envía el formulario a `/api/lead` en el mismo origen.

## Variables secretas en Vercel

Copiar `.env.example` en la configuración del proyecto, no en Git:

- `RESEND_API_KEY`: API key de Resend.
- `LEAD_TO_EMAIL`: casilla real donde Mariano recibirá leads.
- `LEAD_FROM_EMAIL`: remitente de un dominio validado en Resend.
- `LEAD_REPLY_TO`: casilla de respuesta (opcional).
- `ALLOWED_ORIGINS`: orígenes exactos de Vercel y del dominio final, separados por coma. Un origin no lleva ruta. Localhost se admite automáticamente solo fuera de producción.
- `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN`: conexión a Redis para rate limiting e idempotencia. También se aceptan los nombres `KV_REST_API_URL` y `KV_REST_API_TOKEN`.
- `RATE_LIMIT_PER_MINUTE`: máximo de intentos por IP y minuto (por defecto, 10).
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

## Despliegue en Vercel

1. Importar el repositorio en Vercel; no habilitar GitHub Pages.
2. Configurar las variables para Production y Preview, incluido el origin exacto de cada despliegue.
3. Verificar el dominio remitente en Resend y vincular Upstash Redis.
4. Configurar el dominio definitivo y actualizar canonical/OG/Schema en `index.html`.
5. Probar email, deduplicación, límites, consentimiento de analítica y CAPI antes de lanzar campañas.

GitHub aloja el código y la branch de despliegue, pero no sirve el sitio: frontend y `/api/lead` deben permanecer en el mismo proyecto Vercel.

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
- Revisión del aviso de privacidad por Mariano y, de ser necesario, un profesional legal argentino. El texto actual es informativo y marca explícitamente lo pendiente; no reemplaza asesoramiento legal.
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
