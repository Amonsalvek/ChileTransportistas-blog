# chtr-blog-router (Cloudflare Worker)

Publica el blog del droplet dentro de `www.chiletransportistas.com`, que sigue
siendo de Unicorn. Solo pasan por el Worker estas rutas; el resto de www no se
entera de que existe:

| Ruta pública | Quién responde |
|---|---|
| `/blog` | 301 → `/blog/` |
| `/blog/` | droplet (portada del blog) + lista de los artículos que siguen en Unicorn |
| `/blog/assets/…` | droplet |
| `/blog/{slug}/` | Unicorn (artículos viejos, sin cambios) |
| `/transportistas…`, `/contratar-transporte…` | droplet; si el droplet da 404, Unicorn |
| `/sitemap-blog.xml` | droplet |
| lo mismo sin `www` | 301 → www |

El Worker le pide cada página al droplet a través de
`blog.chiletransportistas.com` con la cabecera `X-Chtr-Proxy: worker`. Sin esa
cabecera, nginx responde 301 a www: el subdominio queda solo como origen.

## Desplegar

### Opción A — dashboard (sin instalar nada)

1. Cloudflare → **Workers & Pages** → **Create** → **Create Worker** → nombre
   `chtr-blog-router` → **Deploy**.
2. **Edit code** → borra todo, pega el contenido de `src/index.js` → **Deploy**.
3. **Settings** → **Domains & Routes** → **Add** → **Route**, zona
   `chiletransportistas.com`, una por línea:
   ```
   www.chiletransportistas.com/blog*
   www.chiletransportistas.com/transportistas*
   www.chiletransportistas.com/contratar-transporte*
   www.chiletransportistas.com/sitemap-blog.xml
   chiletransportistas.com/blog*
   chiletransportistas.com/transportistas*
   chiletransportistas.com/contratar-transporte*
   chiletransportistas.com/sitemap-blog.xml
   ```
4. **Settings** → **Runtime** → compatibility date `2025-09-01` o posterior.

### Opción B — wrangler

```bash
cd worker
npm install
npx wrangler login      # una vez
npx wrangler deploy     # sube el código y las rutas de wrangler.toml
```

## Comprobar

```bash
curl -sI https://www.chiletransportistas.com/transportistas/ | grep -iE '^(HTTP|x-chtr-origen)'
# HTTP/2 200 + x-chtr-origen: droplet

curl -sI https://blog.chiletransportistas.com/articulos/como-conseguir-carga-para-tu-camion/ | grep -iE '^(HTTP|location)'
# HTTP/2 301 + location: https://www.chiletransportistas.com/transportistas/como-conseguir-carga-para-tu-camion/
```

Logs en vivo: `npx wrangler tail` o Workers → chtr-blog-router → Logs.

## Pruebas

```bash
cd worker && npm install && npm test
```

Corren el Worker en `workerd` (el mismo runtime de Cloudflare) con el droplet y
Unicorn simulados.

## Si algo sale mal

- **502 "no reconoció la cabecera X-Chtr-Proxy"**: nginx del droplet todavía no
  tiene `deploy/nginx-blog.conf`, o hay una regla de caché "Cache Everything"
  sobre `blog.chiletransportistas.com`. Quítala.
- **Volver atrás**: borra las rutas del Worker (Settings → Domains & Routes).
  www vuelve a ser 100 % Unicorn al instante.
