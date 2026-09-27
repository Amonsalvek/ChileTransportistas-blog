---
name: publicar-articulo
description: Publica un artículo terminado en el blog de ChileTransportistas (www.chiletransportistas.com/transportistas/ o /contratar-transporte/). Arma el HTML desde la plantilla con sus includes SSI, genera la portada con OpenAI, la convierte a WebP y la sube a R2, agrega las tarjetas al hub y a la portada del blog, valida SEO y abre el pull request que lo deja online. Úsala cuando el usuario diga "publica / sube este artículo", "sube el blog", "/publicar-articulo", o entregue un artículo listo para el blog.
---

# Publicar un artículo en el blog de ChileTransportistas

El blog vive en `www.chiletransportistas.com` pero lo sirve el droplet: un Worker
de Cloudflare manda `/blog/`, `/transportistas/*` y `/contratar-transporte/*` al
droplet, y el droplet hace `git pull` de `main` cada 5 minutos. **Publicar =
llegar a `main`.** El resto del sitio es Unicorn y no se toca.

Entrada: el artículo ya escrito (HTML, Markdown o texto). Esta skill no
redacta ni cambia el ángulo editorial: lo convierte en página y lo publica. Si el
texto falla en algo de SEO (título largo, sin respuesta directa arriba, sin FAQ),
propón el ajuste y pregunta antes de aplicarlo.

## 1. Pista, slug y canibalización

- **Pista por intención de búsqueda, no por tema.** Una keyword vive en una
  sola pista:
  - `transportistas`: tiene camiones y busca carga (conseguir carga, costo por
    km, cotizar un flete, carga de retorno, publicidad para transportistas).
  - `contratar-transporte`: necesita mover carga (cómo contratar, cuánto
    cuesta transportar X, qué camión necesito, qué exigirle a un transportista).
- **Slug** desde el título: minúsculas, sin tildes ni ñ, guiones, 3 a 6
  palabras, sin artículos sueltos. `¿Cómo cotizar un flete?` → `como-cotizar-un-flete`.
- **Antes de seguir**, busca si ya hay un artículo que ataque la misma keyword:
  ```bash
  grep -il "<keyword principal>" transportistas/*.html contratar-transporte/*.html
  ```
  Si lo hay, dilo y pregunta si actualizar ese en vez de crear otro.

## 2. El HTML, desde la plantilla

```bash
cp <pista>/base-blog.html <pista>/<slug>.html
```

Reemplaza **todos** los `{{...}}` y borra el comentario grande de la plantilla.
No toques las directivas SSI (`<!--#include ... -->`, `<!--#set ... -->`): son
las que arman navbar, CTAs, migas de pan y footer en el servidor. Cada pista
tiene sus CTAs; la plantilla ya trae los correctos.

Reglas SEO que la plantilla espera:

- `<title>` ≤ 60 caracteres con la keyword al inicio; `<h1>` puede ser más largo.
- meta description de 140-160 caracteres, con la keyword y un motivo para hacer clic.
- canonical, `og:url` y `mainEntityOfPage.@id` = `https://www.chiletransportistas.com/<pista>/<slug>/`.
- `datePublished` y `dateModified` en ISO (`AAAA-MM-DDT12:00:00+00:00`).
- Primer párrafo = respuesta directa a la búsqueda. Después, índice con anclas
  (`<h2 id="...">`), secciones, `<!--#include file="/content-cta....html" -->` a
  mitad del texto (ya está en la plantilla), preguntas frecuentes y conclusión.
- Si hay preguntas frecuentes, agrega un bloque JSON-LD `FAQPage` con las mismas
  preguntas y respuestas (texto plano).
- **Enlaces internos**: 2 o más a artículos de la misma pista (URL relativa
  `/<pista>/<slug>/`) y, si calza, 1 a la otra pista o al cotizador
  (`https://www.chiletransportistas.com/cotizar-transporte-de-carga/`) o al
  registro (`https://www.chiletransportistas.com/mi-cuenta/registrar/`).
- Enlaces externos con `target="_blank" rel="nofollow noopener"`.
- `bc_title` (migas de pan): título corto **sin comillas dobles**.
- Autor: Alejandro Monsalve.

## 3. La portada (OpenAI → WebP → R2)

Escribe **solo la escena**: el script agrega estilo, contexto chileno y la
prohibición de texto y logos. Concreta y visual, relacionada con el tema.

```bash
npm --prefix scripts install          # solo la primera vez en la máquina
node scripts/portada.mjs --slug <slug> \
     --prompt "camión rampla cargando pallets en un centro de distribución de Santiago al amanecer"
```

Sube a R2 (`imagenes-chiletransportistas`, carpeta
`ChileTransportistas-assets/Blog/`) tres WebP de 1200×630, 800×420 y 480×252, e
imprime un JSON con las URLs. La plantilla ya apunta a esas URLs (`{{SLUG}}`), así
que no hay que copiar nada: solo escribe un **alt** descriptivo (qué se ve, en
español; la keyword solo si calza natural) en la `<img>` de la portada y en
`og:image:alt`.

- Ya existe en R2 → la reutiliza y no gasta crédito. Para cambiarla:
  `--reemplazar` (y avisa al usuario que purgue la caché del CDN; el script
  imprime las URLs).
- El usuario trae la imagen (p. ej. hecha en ChatGPT) → `--desde <archivo>`.
- Imágenes dentro del cuerpo → mismo script con `--slug <slug>-<algo>` y el
  mismo patrón `<img srcset ... width height alt loading="lazy">`.
- `moderation_blocked` → reescribe la escena una vez; no reintentes el mismo prompt.
- Sin claves o sin red (`OPENAI_API_KEY`, `R2_*` ausentes, o el host bloqueado
  en una sesión en la nube) → no lo intentes por otro camino: dile al usuario
  que corra ese mismo comando en su computador y sigue con el resto.

## 4. Alta y validación

```bash
python3 scripts/alta_articulo.py <pista>/<slug>.html --etiqueta "Guía práctica"
```

Valida (SSI de la pista correcta, canonical, un solo h1, JSON-LD, alt, sin
marcadores, sin enlaces al subdominio viejo) y agrega la tarjeta al hub de la
pista (sección del año, la crea si hace falta) y a `blog/index.html` (las 3 más
nuevas por pista). Es idempotente: se puede correr de nuevo tras corregir.

- Cualquier `✗` bloquea: corrígelo y repite.
- Los `!` son avisos SEO: arregla los que sean del artículo nuevo.
- En `contratar-transporte`, al llegar al 2º artículo el script quita el
  `noindex` del hub: menciónalo.
- `--etiqueta`: "Guía práctica", "Caso de éxito", "Estrategias", "Precios"…

## 5. Confirmar y publicar

Publicar tiene efecto en producción: **muestra antes** título, slug, URL final,
meta description, la escena de la portada y los avisos pendientes, y espera un
sí explícito.

Luego:

1. Rama `blog/<slug>` desde `main`; commit con el artículo, `transportistas/index.html`
   o `contratar-transporte/index.html` y `blog/index.html`
   (mensaje: `blog: <título corto>`).
2. Push y pull request contra `main` con la URL final en la descripción.
3. Merge solo si el usuario lo pide o lo aprobó para este artículo. A los 5
   minutos del merge el droplet lo publica (y regenera `sitemap-blog.xml`).
4. Entrega: URL del artículo, URL del PR y un recordatorio de pedir la
   indexación en Search Console (Inspección de URLs → Solicitar indexación).

No uses el CMS viejo ni el endpoint `/api/blog/publish`: escriben en
`articulos/`, que ya no existe.

## Requisitos del entorno

- Node 20+ y Python 3.
- `.env` en la raíz del repo (no se versiona) o variables de entorno:
  `OPENAI_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
- En Claude Code en la nube: esas variables en la configuración del entorno y
  red con acceso a `api.openai.com` y `<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.
