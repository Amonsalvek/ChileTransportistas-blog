# CHTR Blog CMS

CMS local para **blog.chiletransportistas.com**. Un solo archivo HTML que se abre
en el navegador y sirve para crear, editar, revisar, publicar y eliminar los
artículos del blog sin tocar el HTML a mano y sin romper la estructura del sitio.

```
Chtr Blogs CMS/
├── chtr-blogs-cms.html      ← el CMS. Es todo lo que necesitas abrir.
├── blogs-api.md             ← documentación del endpoint de publicación (ya existía)
├── README.md                ← este archivo
└── droplet/                 ← lo que se instala en el servidor
    ├── chtr-cms-api.js      servicio Node sin dependencias
    ├── chtr-cms-api.service unidad de systemd
    ├── nginx-chtr-cms.conf  locations de nginx para /api/cms/ y /api/blog/
    ├── .env.example         plantilla de configuración
    └── INSTALL.md           instalación paso a paso
```

---

## Empezar

1. Abre `chtr-blogs-cms.html` con doble clic (Chrome, Edge o Brave).
2. **📁 Carpeta local** → elige la **raíz del repositorio del blog**, o sea la
   carpeta que contiene `articulos/`, `blog.html` y `navbar.html`.
3. Ya puedes ver y editar los artículos. Para publicar y crear pull requests,
   instala el servicio del droplet (`droplet/INSTALL.md`) y configúralo en **⚙︎ Ajustes**.

Sin el servicio del droplet el CMS igual sirve para leer, editar, previsualizar,
validar y guardar en la carpeta local. Lo que requiere servidor es publicar y
crear pull requests.

---

## Qué hace

| | |
|---|---|
| **Ver y navegar** | Todos los artículos de `articulos/` con portada, descripción, fecha y estado. Búsqueda y filtros. |
| **Crear** | Plantilla del sitio con las directivas SSI en su sitio; slug, canonical y URL de portada calculados desde el título. |
| **Editar** | Editor visual o HTML, con vista previa que resuelve los includes SSI de verdad. |
| **Eliminar** | Pull request que borra el archivo y su tarjeta del índice. |
| **Publicar** | Reenvía al endpoint que ya existe: genera la portada, la sube al CDN y escribe el archivo. |
| **Pull requests** | Rama + commit + PR contra el repositorio remoto, para artículos nuevos y ediciones. |
| **Índice** | Agrega, actualiza o quita la tarjeta del artículo en `blog.html`, en la sección del año que corresponde. Si el año no existe, crea la sección y su botón de filtro. |
| **Revisión** | Valida SSI, SEO, estructura y JSON-LD, y muestra el diff exacto antes de mandar nada. |
| **Estado** | Cada operación queda registrada con pendiente / OK / error, la respuesta del servidor y el enlace al PR. |

---

## Lo que el CMS no toca

El sitio arma navbar, footer y CTAs con **server-side includes**. Romper una de
esas directivas rompe la maqueta de la página completa, así que:

- Las cinco directivas se escriben siempre en la misma posición y con la misma
  ruta: `/sticky-mobile-cta.html`, `/right-banner-cta.html`, `/navbar.html`,
  `/content-cta.html`, `/footer.html`.
- En el editor visual aparecen como bloques bloqueados: no se corrompen al
  escribir alrededor, y solo se quitan a propósito.
- La revisión marca **error** si falta alguna, y el servidor rechaza con 422
  cualquier pull request cuyo artículo no lleve navbar y footer.

Además se conservan tal cual:

- La ausencia de `<body>` de apertura, que es la convención de estos archivos.
- Los bloques propios de cada artículo: JSON-LD de FAQ, estilos embebidos,
  Chart.js y los scripts del final del documento.
- Los nombres en español: la carpeta sigue siendo `articulos/` y los slugs se
  derivan del título en español, sin tildes ni ñ.

### Edición conservadora

Al abrir un artículo que ya existe, el CMS guarda una copia de referencia y al
guardar **solo reescribe lo que cambiaste**. Si no cambias nada, el archivo sale
byte por byte idéntico. Si cambias un párrafo, el diff son dos o tres líneas: el
resto del artículo mantiene su sangría y su formato original.

En Metadatos puedes cambiar a modo *Reconstruir* para regenerar el documento
completo desde la plantilla del sitio.

---

## Flujo con la skill de blog

1. El artículo se escribe con la skill y llega como documento HTML completo.
2. **📥 Importar HTML** en el CMS: se pega y quedan cargados título, metadatos,
   JSON-LD, includes SSI y el cuerpo del `<article>`.
3. Se revisa en la pestaña **Revisión** y se ajusta lo que haga falta.
4. **🔀 Crear pull request** para revisarlo en GitHub, o **🚀 Publicar** para
   dejarlo online de inmediato.

Ambos caminos piden confirmación explícita y muestran antes qué se va a hacer.

---

## Dos caminos para que un artículo llegue al sitio

**Pull request (recomendado).** El CMS manda el artículo y, si corresponde, el
`blog.html` actualizado al servicio del droplet, que crea una rama y abre un PR
contra `main`. Nada cambia en producción hasta el merge. Sirve para artículos
nuevos, ediciones y eliminaciones.

**Publicar directo.** Llama al endpoint que ya existe (`/api/blog/publish`):
genera la portada con OpenAI, la sube al CDN y escribe el archivo en
`/var/www/blog/articulos/`. Es inmediato y visible. El CMS avisa siempre antes,
y si el artículo ya existe pregunta antes de sobrescribir.

> Publicar **no toca `blog.html`**: ese endpoint solo escribe el artículo. El CMS
> te avisa cuando el artículo no tiene tarjeta en el índice, porque quedaría
> online pero sin aparecer en el listado del blog.

---

## Seguridad

El navegador solo conoce el **`CMS_TOKEN`**. El `API_SECRET` de publicación, el
`GITHUB_TOKEN` y la clave de OpenAI se quedan en el droplet: el servicio de
publicación se llama desde el servidor, no desde el navegador.

El token se guarda en el almacenamiento local del navegador. En un equipo
compartido, desactiva **“Recordar el token”** en Ajustes.

---

## Navegadores

| | Leer | Escribir en la carpeta | Publicar y PR |
|---|---|---|---|
| Chrome, Edge, Brave | Sí | Sí | Sí |
| Safari, Firefox | Sí (solo lectura) | No — usa **Descargar** | Sí |

Leer y escribir carpetas usa la File System Access API, que hoy solo está en
navegadores Chromium. En el resto el CMS carga la carpeta en modo solo lectura y
los cambios salen por *Descargar* o directamente por pull request.

Los iconos son **Ionicons 7.1.0**, cargados desde unpkg igual que en
`right-banner-cta.html` del sitio. Sin conexión los iconos no se dibujan, pero el
CMS funciona igual: cada botón lleva su texto o su `title`.

---

## Atajos

`⌘S` guardar en la carpeta local · `⌘K` insertar enlace · `⌘B` negrita ·
`N` artículo nuevo · `/` buscar · `Esc` cerrar diálogo
