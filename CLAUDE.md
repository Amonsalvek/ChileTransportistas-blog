# Blog de ChileTransportistas

HTML estático con SSI de nginx, servido por un droplet y publicado dentro de
`www.chiletransportistas.com` por un Worker de Cloudflare. Arquitectura y
despliegue: `deploy/README.md`.

- **Publicar un artículo**: skill `publicar-articulo`
  (`.claude/skills/publicar-articulo/SKILL.md`). Publicar = merge a `main`; el
  droplet hace pull cada 5 minutos.
- El repo es la raíz web del droplet y es **público**: nunca commitear claves
  (`.env` está ignorado; ejemplo en `scripts/env.ejemplo`).
- Las rutas del repo son las URLs: `blog/index.html` → `/blog/`,
  `transportistas/{slug}.html` → `/transportistas/{slug}/`. No existe
  `articulos/` (se migró a `transportistas/`).
- URLs absolutas siempre a `https://www.chiletransportistas.com`; nunca a
  `blog.chiletransportistas.com`. CSS/JS propios en `/blog/assets/`.
- No tocar las directivas SSI (`<!--#include -->`, `<!--#set -->`) de artículos
  y plantillas; `breadcrumbs.html` explica por qué no se pueden escribir
  ejemplos de SSI dentro de comentarios.
- Pruebas: `npm --prefix worker test`, `npm --prefix scripts test`,
  `python3 scripts/alta_articulo.py <artículo> --solo-validar`.
- Español de Chile en textos, comentarios y commits.
