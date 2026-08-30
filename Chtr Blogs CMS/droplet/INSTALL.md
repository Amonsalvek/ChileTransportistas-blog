# Instalación de `chtr-cms-api` en el droplet

Servicio de apoyo para el CMS del blog. **No toca ni reemplaza a `chtr-blog-api`**:
corre en su propio puerto, con su propio `.env` y su propia unidad de systemd.

- El que publica sigue siendo `chtr-blog-api` (`/api/blog/publish`).
- Este servicio agrega `/api/cms/*`: leer los artículos del repositorio y
  **crear pull requests** para altas, ediciones y bajas.
- El navegador solo conoce `CMS_TOKEN`. El `API_SECRET`, el `GITHUB_TOKEN` y la
  clave de OpenAI **no salen nunca del droplet**.

### Arquitectura

| Servicio | Escucha en | Ruta pública |
|---|---|---|
| `chtr-blog-api` | `127.0.0.1:8787` | `/api/blog/` |
| `chtr-cms-api` | `127.0.0.1:8788` | `/api/cms/` |

Nginx con HTTPS es el **único punto de entrada público**. Los dos servicios Node
escuchan solo en localhost: no están expuestos directamente a internet.

Requiere **Node 18 o superior** (usa `fetch` nativo). Sin dependencias de npm.

```bash
node -v    # debe decir v18 o más
```

---

## 1. Token de GitHub

En GitHub → Settings → Developer settings → **Personal access tokens** →
*Fine-grained tokens* → **Generate new token**:

| Campo | Valor |
|---|---|
| Repository access | *Only select repositories* → `Amonsalvek/ChileTransportistas-blog` |
| Contents | **Read and write** |
| Pull requests | **Read and write** |
| Metadata | Read-only (se marca solo) |
| Expiration | 90 días o el que prefieras (anótalo para renovarlo) |

Copia el token: se muestra una sola vez.

---

## 2. Archivos en el droplet

```bash
sudo mkdir -p /opt/chtr-cms-api
```

Sube `chtr-cms-api.js` a `/opt/chtr-cms-api/` (con `scp` desde tu equipo):

```bash
scp chtr-cms-api.js root@TU_DROPLET:/opt/chtr-cms-api/
scp INSTALL.md root@TU_DROPLET:/opt/chtr-cms-api/
```

---

## 3. Configuración

```bash
sudo nano /opt/chtr-cms-api/.env
```

Contenido mínimo (usa `.env.example` como referencia completa):

```ini
CMS_TOKEN=<pega aquí el resultado de: openssl rand -hex 32>
GITHUB_TOKEN=<el token del paso 1>
GITHUB_REPO=Amonsalvek/ChileTransportistas-blog
GIT_BASE_BRANCH=main
BLOG_DIR=/var/www/blog
SOURCE=github
PORT=8788
HOST=127.0.0.1
ALLOW_ORIGINS=*
```

Genera el `CMS_TOKEN` así (no lo escribas a mano, y no lo dejes en el historial):

```bash
openssl rand -hex 32
```

`API_SECRET` se puede dejar vacío: el servicio lo lee solo de
`/opt/chtr-blog-api/.env` para poder reenviar la publicación.

Permisos:

```bash
sudo chown -R www-data:www-data /opt/chtr-cms-api
sudo chmod 600 /opt/chtr-cms-api/.env
```

Verifica que `www-data` pueda leer el `.env` del otro servicio (si no, copia
`API_SECRET` al `.env` del CMS):

```bash
sudo -u www-data test -r /opt/chtr-blog-api/.env && echo "lo lee" || echo "NO lo lee"
```

---

## 4. Servicio de systemd

```bash
sudo cp chtr-cms-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chtr-cms-api
sudo systemctl status chtr-cms-api
```

Prueba local (reemplaza `TU_CMS_TOKEN`):

```bash
curl -s -H "Authorization: Bearer TU_CMS_TOKEN" http://127.0.0.1:8788/api/cms/health
```

Debe responder con `"ok": true` y `"pullRequests": true`. Si dice
`"pullRequests": false`, falta el `GITHUB_TOKEN`.

---

## 5. Nginx

Nginx es el único punto de entrada público. Ambos servicios cuelgan del **mismo
server block HTTPS** de `blog.chiletransportistas.com`:

| Ruta pública | Servicio | Puerto local |
|---|---|---|
| `/api/blog/` | `chtr-blog-api` | `127.0.0.1:8787` |
| `/api/cms/` | `chtr-cms-api` | `127.0.0.1:8788` |

La configuración activa está en `/etc/nginx/sites-available/blog.chiletransportistas.com`
y se habilita con un symlink en `/etc/nginx/sites-enabled/blog.chiletransportistas.com`
que apunta a ese archivo. Verifícalo:

```bash
ls -l /etc/nginx/sites-enabled/blog.chiletransportistas.com
```

### Las dos locations

Edita el server block:

```bash
sudo nano /etc/nginx/sites-available/blog.chiletransportistas.com
```

La ruta del CMS (la que agrega este servicio):

```nginx
location ^~ /api/cms/ {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Origin            $http_origin;

    proxy_connect_timeout 10s;
    proxy_send_timeout    180s;
    proxy_read_timeout    180s;

    client_max_body_size 10m;
    proxy_buffering off;
    ssi off;
}
```

Y la del servicio de publicación, que **debe seguir existiendo tal como está**:

```nginx
location ^~ /api/blog/ {
    proxy_pass http://127.0.0.1:8787;
    ...
}
```

Dos detalles que importan:

- El modificador `^~` hace que estas rutas ganen frente a cualquier location por
  regex, sin depender del orden en que estén escritas.
- `ssi off` evita que nginx intente procesar las respuestas JSON de la API como
  si fueran páginas con includes del sitio.

### No uses una location genérica `/api/`

**No** agregues un bloque como este:

```nginx
# NO: se traga /api/cms/ y lo manda al servicio equivocado
location ^~ /api/ {
    proxy_pass http://127.0.0.1:8787;
}
```

Una location genérica de `/api/` interfiere con el enrutado específico del CMS:
las peticiones a `/api/cms/` terminarían en `chtr-blog-api` (puerto 8787), que no
conoce esas rutas. Cada servicio debe tener su propia location con su prefijo
completo.

### No dejes respaldos en `sites-enabled/`

Nginx carga **todos** los archivos de `/etc/nginx/sites-enabled/`, sin importar
cómo se llamen. Un respaldo ahí dentro se interpreta como una configuración más y
provoca:

```
conflicting server name "blog.chiletransportistas.com"
```

Guarda los respaldos **fuera** de `sites-enabled/`, por ejemplo:

```bash
sudo cp /etc/nginx/sites-available/blog.chiletransportistas.com \
        /etc/nginx/sites-available/blog.chiletransportistas.com.backup
```

### Validar y recargar

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Comprueba que el enrutado quedó como corresponde:

```bash
sudo nginx -T 2>&1 | grep -n -E "location .*api|proxy_pass.*878"
```

Debe mostrar `/api/blog/` apuntando a `127.0.0.1:8787` y `/api/cms/` a
`127.0.0.1:8788`. Si ves los dos prefijos hacia el mismo puerto, quedó una
location genérica de más.

### Prueba desde fuera

```bash
curl -s \
  -H "Authorization: Bearer TU_CMS_TOKEN" \
  https://blog.chiletransportistas.com/api/cms/health
```

Debe responder `"ok": true`. Para comprobar solo el enrutado, sin el token:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://blog.chiletransportistas.com/api/cms/health
```

Un **401 es la respuesta esperada** sin la cabecera `Authorization`: significa que
la petición llegó hasta `chtr-cms-api` y este rechazó la autenticación, o sea que
nginx está enrutando bien. Un 404 o un 502 sí indican problema de configuración.

---

## 6. Conectar el CMS

Abre `chtr-blogs-cms.html` en el navegador → **⚙︎ Ajustes**:

| Campo | Valor |
|---|---|
| URL base | `https://blog.chiletransportistas.com` |
| Token del CMS | el `CMS_TOKEN` |

**Probar conexión** debe mostrar el repositorio y la rama.

---

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/cms/health` | Estado, repositorio, rama y capacidades activas |
| GET | `/api/cms/articles` | Lista de artículos con título, descripción, portada, fechas y SSI |
| GET | `/api/cms/articles/{slug}` | Documento completo del artículo |
| GET | `/api/cms/file?path=blog.html` | Cualquier archivo del repositorio |
| GET | `/api/cms/includes` | Contenido de los includes SSI (para la vista previa) |
| GET | `/api/cms/prs` | Pull requests abiertos creados por el CMS |
| POST | `/api/cms/pr` | Crea rama, commit y pull request |
| POST | `/api/cms/publish` | Reenvía a `/api/blog/publish` con el `API_SECRET` |
| POST | `/api/cms/deploy` | `git pull --ff-only` en `BLOG_DIR` (si `ALLOW_DEPLOY=true`) |

Todos exigen `Authorization: Bearer <CMS_TOKEN>`.

### Cómo crea el pull request

Un solo commit atómico por PR, vía Git Data API (no necesita clon en el droplet):

1. Lee la rama base y su commit.
2. Crea un árbol con **todos** los archivos del cambio (el artículo y, si
   corresponde, `blog.html`).
3. Crea el commit y recién ahí la rama `cms/{nuevo|editar|eliminar}-{slug}-{fecha}`.
4. Abre el pull request contra la rama base.

Si el PR falla, la rama se borra sola: no quedan ramas huérfanas.
Las escrituras se encolan, nunca hay dos a la vez (el droplet es de 512 MB).

### Salvaguarda de SSI

Antes de crear el PR, el servidor rechaza con **422** cualquier artículo que no
lleve `<!--#include file="/navbar.html" -->` y `<!--#include file="/footer.html" -->`.
Es una segunda barrera además de la validación del CMS: un artículo sin sus
includes rompe la maqueta del sitio entero.

---

## Operación

```bash
# estado y logs
sudo systemctl status chtr-cms-api
sudo journalctl -u chtr-cms-api -n 50 --no-pager -l

# reiniciar tras cambiar el .env
sudo systemctl restart chtr-cms-api

# memoria de los dos servicios
systemctl show chtr-cms-api  -p MemoryCurrent
systemctl show chtr-blog-api -p MemoryCurrent
```

### Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| El CMS dice "API sin respuesta" | Nginx no enruta `/api/cms/` | `sudo nginx -T \| grep -E "location .*api"` y revisa el bloque `location ^~ /api/cms/` |
| `/api/cms/` responde 404 o rutas desconocidas | Una `location ^~ /api/` genérica manda todo al 8787 | Bórrala: cada servicio con su prefijo completo |
| `conflicting server name` al recargar | Hay un respaldo dentro de `sites-enabled/` | Muévelo a `sites-available/…​.backup` |
| "Token del CMS incorrecto" | `CMS_TOKEN` distinto | Compara Ajustes del CMS con el `.env` |
| `"pullRequests": false` | Falta `GITHUB_TOKEN` | Agrégalo al `.env` y reinicia |
| GitHub responde 403 | El token no tiene permiso de escritura o venció | Regenera el fine-grained token |
| `"publish": false` | No se pudo leer `API_SECRET` | Copia `API_SECRET` al `.env` del CMS |
| Timeout al publicar | La portada tardó más de 100 s (Cloudflare) | Revisa si igual se publicó antes de reintentar |

### Renovar el token de GitHub

Cuando expire, los PR fallan con 403. Genera uno nuevo, cámbialo en el `.env` y:

```bash
sudo systemctl restart chtr-cms-api
```
