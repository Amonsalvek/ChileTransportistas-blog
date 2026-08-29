# Bifurcación del blog por intención

El blog dejó de ser una sola lista de artículos. Ahora son dos pistas, y la
pista se decide por **intención de búsqueda**, no por tema.

| Pista | Slug | Quién es | Qué produce |
|---|---|---|---|
| Transportistas | `/transportistas/` | Tiene camiones, busca carga | Registros en el directorio y prospectos de Momentum |
| Generadores de carga | `/contratar-transporte/` | Necesita mover carga | El inventario de solicitudes que se vende |

Son dos embudos con métricas distintas. No los mires en un solo dashboard.

`/articulos/` es **legado**: sigue sirviendo los cuatro artículos publicados
hasta el día de la migración, y después queda solo como origen de 301.

---

## La regla dura: una keyword, una pista

Ya hay canibalización nacional en 4 URLs. Con dos pistas escribiendo sobre
"transporte de carga" se multiplica. Regla: **cada keyword vive en una sola
pista**, y la pista la define la intención.

| Va en `/transportistas/` | Va en `/contratar-transporte/` |
|---|---|
| cómo conseguir carga | cómo contratar transporte |
| costo por kilómetro | cuánto cuesta transportar {X} |
| cómo cotizar un flete | qué camión necesito para {X} |
| carga de retorno | qué le exijo a un transportista |
| publicidad para transportistas | cómo comparar cotizaciones de flete |

Lleva esto en una hoja con columna `pista` desde el primer artículo. Después
de 30 artículos ya no se desenreda.

---

## Estado actual

Hecho:

- Portada bifurcada en `blog.html`, con dos links reales y rastreables.
- Hub `/transportistas/` con los 4 artículos y el filtro por año.
- Hub `/contratar-transporte/`, todavía sin artículos y con `noindex, follow`.
- Migas de pan SSI + JSON-LD `BreadcrumbList` en los 4 artículos.
- CTAs propios de cada pista (`*-carga.html` empujan al cotizador, no al
  registro).
- Plantilla `contratar-transporte/base-blog.html` para escribir la pista nueva.

Pendiente, en este orden:

1. **Publicar 2-3 artículos en `/contratar-transporte/`** y recién ahí quitar
   el `noindex` de su hub. Un hub vacío indexado es contenido delgado, y el
   dominio no está para regalar señales.
2. **Migrar `/articulos/` a `/transportistas/`** — ver abajo.
3. Reemplazar el CTA del banner lateral de la pista carga por su propio lead
   magnet (checklist para cotizar un flete sin que te inflen el precio)
   cuando exista la landing. Hoy apunta al cotizador.

---

## La migración de `/articulos/`: cuándo y cómo

**Cuándo.** No ahora. El sitio viene demotado desde el 8-9 de julio y hay una
intervención de cama baja midiéndose a 2-4 semanas. Si mueves URLs en
paralelo, el ruido del 301 y el ruido de julio quedan mezclados y no vas a
poder leer ninguna de las dos cosas.

Espera a tener **lectura estable de cama baja**, y entonces migra los cuatro
artículos en un solo lote. Ponle fecha en el calendario: la migración "cuando
pueda" es la que no llega nunca y deja el legado diez años.

**Cómo.**

```bash
python3 deploy/migrar_articulos_a_transportistas.py            # simulación
python3 deploy/migrar_articulos_a_transportistas.py --aplicar  # de verdad
```

Después:

1. Pega el bloque `map` que imprime el script en nginx, a nivel `http`.
2. Descomenta el bloque de migración de `deploy/nginx-blog-pistas.conf`,
   `sudo nginx -t && sudo systemctl reload nginx`.
3. Corre `update_sitemap_blog.py` en el droplet.
4. Reenvía el sitemap en Search Console y deja pasar el reprocesamiento.

El fallback del `location ^~ /articulos/` manda cualquier slug olvidado en el
`map` al hub `/transportistas/` en vez de a un 404. El dominio ya tiene deuda
de 404s: no le sumes.

---

## Los 10 artículos de Unicorn

`www.chiletransportistas.com/blog/{slug}` se queda donde está. Consolidar todo
el blog en el droplet es otro proyecto: no lo mezcles con esto.

Ojo: hasta ahora los cuatro artículos del subdominio tenían `rel="canonical"`
apuntando a URLs de `www/blog/` **que devuelven 404**. Eso le decía a Google
que la versión buena de cada página estaba en otro lado, y en ese otro lado no
había nada. Ya está corregido a canonical autorreferencial en
`blog.chiletransportistas.com`. Vale la pena revisar en Search Console si
alguna de esas URLs quedó como "Página alternativa con etiqueta canónica
adecuada" o "Excluida por noindex/canonical" y pedir reindexación.
