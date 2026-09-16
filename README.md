# ME Seguros — landing consolidada

Landing mobile-first de Mariano Esteban, Productor Asesor de Seguros (matrícula N.º 87555), preparada para el funnel **Meta Ads → cotización → contacto**. El proyecto mantiene HTML, CSS y JavaScript sin framework: Vercel publica los archivos estáticos y ejecuta la Function del mismo repositorio.

## Arquitectura resultante

- **Un solo origen en Vercel:** el navegador envía siempre `POST /api/lead`; GitHub es únicamente el repositorio.
- **Entrega confirmada:** la Function valida, limita por IP, reclama el `event_id` y entrega por Resend. El navegador muestra éxito únicamente cuando recibe `lead_received: true`.
- **Persistencia de producción:** Upstash Redis o Vercel KV compatible con REST mantiene rate limiting e idempotencia. El fallback en memoria solo funciona fuera de `NODE_ENV=production`.
- **Idempotencia:** estados `processing`, `delivered` y `delivered:capi`. Un duplicado `processing` devuelve `409`; uno entregado devuelve confirmación sin solicitar otro correo. Resend recibe `Idempotency-Key: lead/<event_id>`.
- **Fallos parciales seguros:** un fallo de email libera el claim; un fallo de CAPI o de Redis posterior al email no niega un lead ya recibido.
- **Presupuesto de tiempo:** Redis 0,6 s por operación, Resend 3 s y CAPI 1,8 s. Los pasos críticos se mantienen dentro de `maxDuration: 10`; cada llamada externa usa `AbortController`.

## Privacidad, atribución y eventos

Hay dos consentimientos separados. El de contacto es obligatorio; el publicitario es opcional. Antes de aceptar medición no se carga Pixel, no se envía CAPI y no se guardan UTM, `fbclid`, `fbp` o `fbc` en `localStorage`. La preferencia puede revisarse desde el pie de página. Si el formulario ya se vio, `ViewContent` queda pendiente en memoria y se emite una sola vez al aceptar.

Con consentimiento se conservan `first_touch`, `last_touch`, URL y fecha de conversión, UTM, `fbclid`, `fbp` y `fbc`. El email incluye la atribución. CAPI recibe teléfono argentino normalizado, nombre, apellido, localidad y país hasheados, además de IP, user-agent y los identificadores disponibles.

| Evento | Condición | Canal |
| --- | --- | --- |
| `PageView` | al cargar Pixel después del consentimiento | Pixel |
| `ViewContent` | primera vista del formulario; queda pendiente hasta consentir | Pixel |
| `Contact` | clic en WhatsApp, no implica mensaje enviado | Pixel |
| `Lead` | Resend confirmó la entrega | Pixel + CAPI con el mismo `event_id` |

## Variables de Vercel

Copiar los nombres de `.env.example` en **Project Settings → Environment Variables**:

- `RESEND_API_KEY`: clave privada de Resend.
- `LEAD_TO_EMAIL`: correo donde Mariano recibe las consultas.
- `LEAD_FROM_EMAIL`: remitente perteneciente al dominio verificado en Resend.
- `LEAD_REPLY_TO`: correo para respuestas.
- `ALLOWED_ORIGINS`: orígenes HTTPS exactos, separados por coma y sin rutas.
- `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN`: conexión REST privada de producción.
- `META_PIXEL_ID`: ID del Pixel/dataset; también se copia como valor público en `js/config.js`.
- `META_ACCESS_TOKEN`: token privado de Conversions API.
- `META_API_VERSION`: versión validada de Graph API, por ejemplo `v23.0`.
- `META_TEST_EVENT_CODE`: solo durante pruebas en Events Manager; quitarlo al lanzar.

Nunca agregar claves o tokens a `js/config.js`. `META_PIXEL_ID` es el único dato público requerido allí.

## Dominio y SEO: bloqueo deliberado antes del deploy

El dominio final no fue informado. Para no inventarlo, `index.html` usa el marcador inequívoco `https://REEMPLAZAR-CON-DOMINIO-REAL.example/` en canonical, `og:url`, `og:image` y Schema. **Antes de publicar**, reemplazar todas sus apariciones por el dominio HTTPS real y agregar esos mismos orígenes a `ALLOWED_ORIGINS`. No lanzar campañas con el marcador.

## Pasos manuales

### Vercel

1. Importar este repositorio y seleccionar la branch que se fusione como Production Branch.
2. No configurar un directorio separado ni GitHub Pages: Vercel debe servir frontend y `/api/lead` juntos.
3. Crear las variables anteriores para Production (y valores aislados para Preview si se prueba allí).
4. Crear/conectar Upstash Redis o Vercel KV REST y comprobar que inyecte URL y token compatibles.
5. Asignar el dominio definitivo, reemplazar el marcador SEO, actualizar `ALLOWED_ORIGINS` y desplegar.
6. Enviar un lead real y comprobar email, respuesta JSON, logs y headers de seguridad.

### Resend

1. Verificar el dominio remitente (SPF/DKIM) y crear una API key con el alcance mínimo necesario.
2. Configurar remitente, destinatario y reply-to en Vercel.
3. Confirmar entrega real, spam y formato del email. No considerar listo el funnel con una dirección de prueba restringida.

### Meta Events Manager

1. Crear/elegir Pixel y dataset, copiar el ID al frontend y a Vercel, y generar el token CAPI solo para Vercel.
2. Configurar temporalmente `META_TEST_EVENT_CODE` y probar ambas decisiones de consentimiento.
3. Confirmar `PageView`, `ViewContent`, `Contact` y `Lead`; verificar que Browser/Server deduplican `Lead` por el mismo `event_id`.
4. Revisar calidad de coincidencia, diagnóstico, dominio verificado y parámetros UTM.
5. Eliminar `META_TEST_EVENT_CODE` antes de activar campañas.

## Desarrollo y auditoría

Requiere Node.js 20 o superior.

```bash
npm test
npm run check
git diff --check
```

Para pruebas locales completas, usar `vercel dev`; localhost está permitido exclusivamente fuera de producción. Los tests cubren validación, automotor, teléfonos argentinos, CORS, origen del evento, rate limiting, estados idempotentes, reintentos, fallos parciales, consentimiento estricto y deduplicación Pixel/CAPI.

## Pendientes operativos no públicos

- Confirmar dominio final y reemplazar el marcador SEO.
- Completar valores reales de Vercel, verificar Resend y configurar Meta.
- Definir internamente el plazo de retención y el procedimiento para solicitudes de privacidad; el aviso público ya está redactado sin notas de trabajo.
- Realizar control legal final del aviso para la operación concreta de Mariano antes de invertir en pauta.
