# El blog en www.chiletransportistas.com

Desde septiembre de 2026 el blog ya no vive en `blog.chiletransportistas.com`.
Se publica dentro del dominio principal, que sigue siendo de Unicorn:

| URL pública | Qué es | Quién la sirve |
|---|---|---|
| `www.chiletransportistas.com/blog/` | portada del blog | droplet |
| `…/transportistas/{slug}/` | artículos para quien tiene camiones y busca carga | droplet |
| `…/contratar-transporte/{slug}/` | artículos para quien necesita mover carga | droplet |
| `…/sitemap-blog.xml` | sitemap del blog (con imágenes) | droplet |
| `…/blog/{slug}/` | artículos viejos hechos en Unicorn | Unicorn |
| todo lo demás | el sitio | Unicorn |

```
visita ──► Cloudflare ──► ¿ruta del blog? ──no──► Unicorn
                              │
                             sí  Worker chtr-blog-router (worker/)
                              ▼
                 blog.chiletransportistas.com  + cabecera X-Chtr-Proxy: worker
                              ▼
                 nginx del droplet (deploy/nginx-blog.conf) → /var/www/blog + SSI
```

El subdominio queda **solo como origen** del Worker: una visita directa recibe
un 301 a la URL equivalente en www (así Google traslada las señales), y siguen
ahí `/api/blog/`, `/api/cms/` y la renovación del certificado.

## Estructura del repo = estructura de URLs

```
blog/index.html                 → /blog/
blog/assets/{css,js}/           → /blog/assets/…   (en www, /assets/ es de Unicorn)
transportistas/index.html       → /transportistas/
transportistas/{slug}.html      → /transportistas/{slug}/
transportistas/base-blog.html   plantilla (404 en producción)
contratar-transporte/…          ídem
navbar.html, footer.html, …     parciales SSI, solo como include
scripts/                        portada.mjs (OpenAI → WebP → R2), alta_articulo.py
worker/                         el Worker de Cloudflare, con sus pruebas
deploy/                         nginx, migración y publicación automática
.claude/skills/publicar-articulo/  la skill para publicar con Claude
```

nginx sirve con **lista blanca**: solo esas rutas. `.git/`, `deploy/`,
`scripts/`, `worker/`, etc. responden 404 aunque estén en el webroot.

## Publicación automática

El droplet corre `deploy/actualizar.sh` cada 5 minutos (`/etc/cron.d/chtr-blog`):
si `main` avanzó, hace fast-forward y regenera el sitemap. **Publicar un
artículo = hacer merge a `main`.** Log: `/var/log/chtr-blog-actualizar.log`.

Los cambios a `deploy/nginx-blog.conf` **no** se aplican solos (el log avisa):
`sudo bash /var/www/blog/deploy/aplicar-nginx.sh`, que prueba con `nginx -t` y
restaura la anterior si falla.

## La migración (una vez)

Orden, para que no haya ni un minuto de 404:

1. **Merge a `main`** de la rama con la migración.
2. **Worker** (ver `worker/README.md`): dashboard de Cloudflare o
   `npx wrangler deploy`. Mientras el droplet tenga la config vieja, el Worker
   igual funciona: lo que el droplet no conoce cae en Unicorn.
3. **Droplet**:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Amonsalvek/ChileTransportistas-blog/main/deploy/migrar-a-www.sh | sudo bash
   ```
   Respaldo, pull, artículos sueltos de `articulos/` → `transportistas/`,
   sitemap, nginx (con `nginx -t`), cron y pruebas. Al final imprime cómo
   deshacerlo.
4. **Search Console**: agregar `sitemap-blog.xml` en la propiedad de www; si
   existe la propiedad del subdominio, usar *Cambio de dirección* hacia www.

### Redirecciones 301 del subdominio

| Antes | Ahora |
|---|---|
| `blog.chiletransportistas.com/` | `www.chiletransportistas.com/blog/` |
| `/articulos/{slug}/` (y `.html`, sin barra) | `www…/transportistas/{slug}/` |
| `/transportistas/…`, `/contratar-transporte/…` | misma ruta en www |
| `/sitemap-blog.xml`, `/robots.txt` | misma ruta en www |
| `/assets/…` | `www…/blog/assets/…` |
| cualquier otra | `www…/blog/` |

### Portada del blog vs. el `/blog` de Unicorn

`/blog/` ahora es la portada del droplet (las dos pistas + últimos artículos).
Los artículos que Unicorn tiene en `/blog/{slug}/` siguen donde están, y el
Worker los lista en la sección "Más artículos del blog" de la portada, leyendo
el índice de Unicorn una vez por hora: ninguno queda huérfano de enlaces
internos.

Pendiente recomendado: migrar esos artículos de Unicorn a su pista (con 301
desde `/blog/{slug}/`) para tener todo el blog en un solo sistema.

## La regla dura: una keyword, una pista

La pista la define la **intención de búsqueda**, no el tema.

| Va en `/transportistas/` | Va en `/contratar-transporte/` |
|---|---|
| cómo conseguir carga | cómo contratar transporte |
| costo por kilómetro | cuánto cuesta transportar {X} |
| cómo cotizar un flete | qué camión necesito para {X} |
| carga de retorno | qué le exijo a un transportista |
| publicidad para transportistas | cómo comparar cotizaciones de flete |

`/contratar-transporte/` sale con `noindex, follow` mientras esté vacío;
`scripts/alta_articulo.py` lo quita al publicar el segundo artículo.
