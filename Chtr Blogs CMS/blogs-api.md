# Módulo: Publicación automática en blog.chiletransportistas.com

> Fusionar con la skill de blog existente. Este módulo cubre **solo la fase de publicación**:
> qué generar, con qué formato y cómo entregarlo al endpoint. La investigación, el ángulo
> editorial y la redacción se rigen por las reglas que ya están en la skill.

---

## 1. Cuándo aplica este módulo

Aplica cuando el artículo ya está **escrito y aprobado** y hay que dejarlo publicado.

No aplica si:

* todavía se está definiendo el tema o el esquema,
* el usuario pidió solo un borrador para revisar,
* el artículo se va a publicar en otro dominio.

**Regla dura:** nunca publicar sin confirmación explícita del usuario. Primero se muestra el
artículo, se aprueba, y recién ahí se llama al endpoint. Publicar es una acción con efecto
en producción, no un paso más del flujo.

---

## 2. El endpoint

```
POST https://blog.chiletransportistas.com/api/blog/publish
Authorization: Bearer <API_SECRET>
Content-Type: application/json
```

El `API_SECRET` está en `/opt/chtr-blog-api/.env` del droplet. Nunca se escribe en el chat,
ni en un archivo, ni en el historial de comandos. Se lee así en el momento de usarlo:

```bash
SECRET=$(grep '^API_SECRET=' /opt/chtr-blog-api/.env | cut -d= -f2-)
```

### Qué hace el endpoint, en orden

1. Genera la imagen de portada con OpenAI (formato webp, horizontal).
2. La sube a Cloudflare R2 → queda pública en el CDN.
3. Escribe el HTML en `/var/www/blog/articulos/{slug}.html` de forma atómica.
4. Regenera el sitemap si está habilitado.

Si algo falla en cualquier paso, **no se escribe nada a medias**: o queda todo o no queda nada.

---

## 3. Contrato del request

```json
{
  "slug": "como-conseguir-carga-para-tu-camion",
  "title": "Cómo conseguir carga para tu camión",
  "html": "<!DOCTYPE html>...",
  "image": {
    "prompt": "camión de carga en la Ruta 5 al atardecer, vista lateral",
    "regenerate": false
  },
  "overwrite": false,
  "skipImage": false
}
```

| Campo | Obligatorio | Notas |
|---|---|---|
| `slug` | sí | Solo minúsculas, números y guiones. Sin tildes, sin `ñ`, sin guion al inicio/final. Define la URL y el nombre de la imagen. |
| `html` | sí | El documento completo del artículo (ver sección 5). |
| `title` | no | Se usa como respaldo para el prompt de imagen si no se pasa `image.prompt`. |
| `image.prompt` | no | Descripción de la portada. Si se omite, se arma uno genérico desde el `title`. |
| `image.regenerate` | no | `true` fuerza generar de nuevo aunque la imagen ya exista en R2. |
| `overwrite` | no | `true` permite reemplazar un artículo ya publicado. |
| `skipImage` | no | `true` publica sin tocar OpenAI ni R2. Útil para corregir texto de un artículo ya publicado. |

### Reglas de slug

Derivar del título, no inventarlo:

* minúsculas, espacios → guiones
* quitar tildes (`á`→`a`), `ñ`→`n`
* quitar artículos y preposiciones sueltas si alarga de más
* apuntar a 3–6 palabras

`"¿Cómo conseguir carga para tu camión?"` → `como-conseguir-carga-para-tu-camion`

### Comportamiento de la imagen

El endpoint **reutiliza** la imagen si ya existe en R2 para ese slug. Esto es intencional:
evita gastar crédito de OpenAI al republicar. Solo se regenera con `regenerate: true`.

---

## 4. Respuestas

Éxito:

```json
{
  "ok": true,
  "slug": "...",
  "articleUrl": "https://blog.chiletransportistas.com/articulos/{slug}/",
  "filePath": "/var/www/blog/articulos/{slug}.html",
  "imageUrl": "https://cdn.chiletransportistas.com/ChileTransportistas-assets/Blog/{slug}.webp",
  "imageStatus": "created | reused | regenerated | skipped",
  "sitemap": "ok | disabled | error: ..."
}
```

Errores y qué hacer con cada uno:

| Código | Significado | Acción |
|---|---|---|
| 400 | `slug` o `html` inválidos | Corregir y reintentar. |
| 401 | Secreto incorrecto | Se está mandando la key equivocada. **No es la de OpenAI**, es `API_SECRET`. |
| 409 | El artículo ya existe | **Preguntar al usuario** antes de mandar `overwrite: true`. Nunca sobrescribir por iniciativa propia. |
| 500 | Falló OpenAI, R2 o el disco | Leer el mensaje: dice cuál de los tres. No reintentar en loop. |
| 524 | Timeout de Cloudflare (100s) | La imagen tardó demasiado. Verificar si igual se publicó antes de reintentar. |

**Ante un 500 por moderación de OpenAI** (`moderation_blocked`): no reintentar con el mismo
prompt. Reescribir el prompt de imagen y volver a intentar una sola vez.

---

## 5. El HTML del artículo

El campo `html` debe contener el **documento completo**, no un fragmento. El sitio usa SSI,
así que los componentes compartidos se incluyen por directiva, no se copian.

Elementos obligatorios en cada artículo:

* `<!DOCTYPE html>` y `<html lang="es">`
* `<title>` y `<meta name="description">` optimizados para búsqueda
* `<link rel="canonical">` apuntando a `https://blog.chiletransportistas.com/articulos/{slug}/`
* Open Graph: `og:title`, `og:description`, `og:image` (= el `imageUrl` del CDN), `og:url`
* Los includes SSI del sitio (navbar, footer, banners, CTA)
* La imagen de portada referenciada desde el CDN, con `alt` descriptivo
* Un solo `<h1>`, coincidente con el título del artículo

**Importante:** el `imageUrl` es predecible antes de publicar
(`https://cdn.chiletransportistas.com/ChileTransportistas-assets/Blog/{slug}.webp`),
así que se puede escribir en el `<head>` del HTML antes de llamar al endpoint. No hace falta
publicar dos veces.

> **Pendiente de completar:** copiar aquí el template exacto tomado de un artículo existente
> en `/var/www/blog/articulos/`, con las directivas SSI reales. Hasta tenerlo, revisar un
> artículo publicado antes de generar el HTML, para no romper la estructura del sitio.

---

## 6. Flujo completo

1. Escribir el artículo según las reglas editoriales de la skill.
2. Derivar el `slug` del título.
3. Componer el prompt de imagen (ver sección 7).
4. Armar el HTML completo, con el `imageUrl` ya calculado.
5. **Mostrar al usuario** el título, el slug, la URL final y el prompt de imagen.
6. Esperar aprobación explícita.
7. Llamar al endpoint.
8. Reportar el resultado con la URL del artículo y la de la imagen, para que verifique.

Después de publicar, sugerir revisar la portada: la imagen es lo único que no se puede
previsualizar antes, y a veces conviene regenerarla con otro prompt.

---

## 7. Prompt de imagen

El servidor ya agrega estilo, contexto de transporte chileno y la restricción de "sin texto".
El `image.prompt` solo debe aportar **la escena concreta**.

Bien: `"camión rampla en la Ruta 5 al atardecer, vista lateral, cordillera de fondo"`
Mal: `"imagen profesional de alta calidad sobre transporte, estilo fotográfico, sin texto"`
(redundante: eso ya lo pone el servidor)

Criterios:

* escena concreta y visualizable, no un concepto abstracto
* relacionada con el tema del artículo, no genérica
* contexto chileno cuando aporte (cordillera, puerto, ruta, desierto)
* nunca pedir texto, logos ni marcas: el modelo los renderiza mal y quedan feos

---

## 8. Restricciones operativas

* **Timeout de 100s** (Cloudflare, plan free). Generar la imagen suele tardar 30–60s. Si se
  activa `quality: high` en el `.env`, el riesgo de 524 sube bastante.
* **Droplet de 512MB.** No paralelizar publicaciones: de a un artículo por vez.
* **El sitemap está deshabilitado** por defecto (`RUN_SITEMAP=false`). Mientras siga así, hay
  que actualizarlo aparte o avisar al usuario que quedó pendiente.
* El servicio corre como `www-data` bajo systemd (`chtr-blog-api`). Si el endpoint no responde:
  `systemctl status chtr-blog-api` y `journalctl -u chtr-blog-api -n 30 --no-pager -l`.

---

## 9. Qué no hacer

* No sobrescribir un artículo existente sin preguntar.
* No reintentar en loop ante un 500: leer el error primero.
* No escribir el `API_SECRET` en ningún archivo, mensaje ni comando que quede en el historial.
* No publicar sin aprobación del usuario.
* No inventar el `imageUrl`: se calcula con la fórmula del CDN, siempre igual.
* No mandar fragmentos de HTML: siempre el documento completo.