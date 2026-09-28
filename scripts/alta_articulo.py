#!/usr/bin/env python3
"""
Valida un artículo y lo da de alta en el blog: tarjeta en el hub de su pista
y en la portada (/blog/).

    python3 scripts/alta_articulo.py transportistas/como-cotizar-un-flete.html --etiqueta "Guía práctica"
    python3 scripts/alta_articulo.py contratar-transporte/x.html --solo-validar

Qué revisa (errores bloquean el alta; avisos no):
  - que no queden {{marcadores}} de la plantilla
  - canonical, og:url y mainEntityOfPage = https://www.chiletransportistas.com/{pista}/{slug}/
  - un solo <h1>, <title> y meta description
  - los includes SSI de SU pista (los CTA de transportista no van en la
    pista de carga y viceversa) + navbar, footer y migas de pan
  - migas de pan: bc_hub_url de la pista, bc_title sin comillas dobles
  - JSON-LD que parsea
  - nada apuntando a blog.chiletransportistas.com ni a /articulos/
  - SEO: largo del title y de la description, alt y dimensiones de las
    imágenes, portada sin lazy, enlaces internos

Qué escribe (idempotente: correrlo dos veces no duplica nada):
  - la tarjeta en {pista}/index.html, en la sección de su año (la crea si no
    existe, con su botón en el filtro)
  - la tarjeta en blog/index.html, feed de su pista, dejando las 3 más nuevas
  - en /contratar-transporte/: al llegar al 2º artículo quita el noindex del hub
"""
import argparse
import datetime as dt
import html
import json
import os
import re
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WWW = "https://www.chiletransportistas.com"
CDN_BLOG = "https://cdn.chiletransportistas.com/ChileTransportistas-assets/Blog/"
PISTAS = {
    "transportistas": {
        "hub_name": "Transportistas",
        "ssi": ["/sticky-mobile-cta.html", "/right-banner-cta.html", "/content-cta.html"],
        "ssi_ajenos": ["-carga.html"],
    },
    "contratar-transporte": {
        "hub_name": "Contratar transporte",
        "ssi": ["/sticky-mobile-cta-carga.html", "/right-banner-cta-carga.html", "/content-cta-carga.html"],
        "ssi_ajenos": ['"/sticky-mobile-cta.html"', '"/right-banner-cta.html"', '"/content-cta.html"'],
    },
}
SSI_COMUNES = ["/navbar.html", "/footer.html", "/breadcrumbs.html"]
MAX_FEED_PORTADA = 3
MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]


# ---------------------------------------------------------------------------
# Lectura del artículo
# ---------------------------------------------------------------------------

def texto_plano(fragmento):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", fragmento))).strip()


def meta(doc, atributo, valor):
    m = re.search(r'<meta[^>]+%s=["\']%s["\'][^>]*>' % (atributo, re.escape(valor)), doc, re.I)
    if not m:
        return None
    c = re.search(r'content=["\']([^"\']*)["\']', m.group(0), re.I)
    return html.unescape(c.group(1)) if c else None


def leer_articulo(ruta):
    rel = os.path.relpath(os.path.abspath(ruta), RAIZ).replace(os.sep, "/")
    m = re.fullmatch(r"(transportistas|contratar-transporte)/([a-z0-9]+(?:-[a-z0-9]+)*)\.html", rel)
    if not m:
        sys.exit(f"✗ {rel}: el artículo tiene que estar en transportistas/ o contratar-transporte/ "
                 "y llamarse {{slug}}.html (minúsculas, números y guiones)")
    pista, slug = m.groups()
    if slug in ("index", "base-blog"):
        sys.exit(f"✗ {rel} no es un artículo")
    with open(os.path.join(RAIZ, rel), encoding="utf-8") as fh:
        doc = fh.read()
    return rel, pista, slug, doc


def datos_articulo(doc, slug):
    h1s = re.findall(r"<h1[^>]*>(.*?)</h1>", doc, re.S | re.I)
    titulo = texto_plano(h1s[0]) if h1s else ""
    fecha = None
    for bloque in re.findall(r'<script type="application/ld\+json">(.*?)</script>', doc, re.S):
        try:
            data = json.loads(bloque)
        except ValueError:
            continue
        for nodo in data if isinstance(data, list) else [data]:
            if isinstance(nodo, dict) and nodo.get("datePublished"):
                fecha = nodo["datePublished"][:10]
    og_image = meta(doc, "property", "og:image") or ""
    # alt de la portada: la primera <img> del <article>
    art = re.search(r"<article\b.*?</article>", doc, re.S | re.I)
    alt = ""
    if art:
        img = re.search(r"<img\b[^>]*>", art.group(0), re.I)
        if img:
            a = re.search(r'\balt=["\']([^"\']*)["\']', img.group(0))
            alt = html.unescape(a.group(1)) if a else ""
    return {"titulo": titulo, "fecha": fecha, "og_image": og_image, "alt": alt or titulo}


# ---------------------------------------------------------------------------
# Validación
# ---------------------------------------------------------------------------

def validar(doc, pista, slug):
    errores, avisos = [], []
    url = f"{WWW}/{pista}/{slug}/"

    restos = sorted(set(re.findall(r"\{\{[^}]{0,60}\}\}", doc)))
    if restos:
        errores.append("quedan marcadores de la plantilla: " + ", ".join(restos[:6]))

    if not re.match(r"\s*<!DOCTYPE html>", doc, re.I):
        errores.append("falta <!DOCTYPE html> al inicio")
    if not re.search(r'<html[^>]+lang="es', doc, re.I):
        errores.append('falta <html lang="es">')

    h1 = re.findall(r"<h1\b", doc, re.I)
    if len(h1) != 1:
        errores.append(f"tiene {len(h1)} <h1>; debe tener exactamente uno")

    t = re.search(r"<title>(.*?)</title>", doc, re.S | re.I)
    if not t or not texto_plano(t.group(1)):
        errores.append("falta <title>")
    elif len(texto_plano(t.group(1))) > 65:
        avisos.append(f"<title> de {len(texto_plano(t.group(1)))} caracteres: Google corta cerca de 60")

    desc = meta(doc, "name", "description")
    if not desc:
        errores.append("falta meta description")
    elif not 110 <= len(desc) <= 165:
        avisos.append(f"meta description de {len(desc)} caracteres (ideal 140-160)")

    canon = re.search(r'<link[^>]+rel=["\']canonical["\'][^>]*>', doc, re.I) or \
        re.search(r'<link[^>]+href=["\'][^"\']+["\'][^>]+rel=["\']canonical["\'][^>]*>', doc, re.I)
    href = re.search(r'href=["\']([^"\']+)["\']', canon.group(0)).group(1) if canon else None
    if href != url:
        errores.append(f"canonical es {href!r}; debe ser {url}")
    if meta(doc, "property", "og:url") != url:
        errores.append(f"og:url debe ser {url}")
    if f'"@id": "{url}"' not in doc and f'"@id":"{url}"' not in doc:
        errores.append(f'mainEntityOfPage.@id del JSON-LD debe ser "{url}"')

    for inc in SSI_COMUNES + PISTAS[pista]["ssi"]:
        if f'<!--#include file="{inc}" -->' not in doc:
            errores.append(f'falta el include SSI <!--#include file="{inc}" -->')
    for ajeno in PISTAS[pista]["ssi_ajenos"]:
        for inc in re.findall(r'<!--#include file="([^"]+)" -->', doc):
            if ajeno.strip('"') == inc or (ajeno.startswith("-") and inc.endswith(ajeno)):
                errores.append(f"include {inc} es de la otra pista")

    hub_url = re.search(r'<!--#set var="bc_hub_url" value="([^"]*)" -->', doc)
    if not hub_url or hub_url.group(1) != f"/{pista}/":
        errores.append(f'migas de pan: bc_hub_url debe ser "/{pista}/"')
    hub_name = re.search(r'<!--#set var="bc_hub_name" value="([^"]*)" -->', doc)
    if not hub_name or hub_name.group(1) != PISTAS[pista]["hub_name"]:
        errores.append(f'migas de pan: bc_hub_name debe ser "{PISTAS[pista]["hub_name"]}"')
    bc = re.search(r'<!--#set var="bc_title" value="(.*?)" -->', doc)
    if not bc:
        errores.append("migas de pan: falta bc_title")
    elif '"' in bc.group(1) or "&quot;" in bc.group(1):
        errores.append("migas de pan: bc_title no puede llevar comillas dobles (rompe el JSON-LD)")

    for i, bloque in enumerate(re.findall(r'<script type="application/ld\+json">(.*?)</script>', doc, re.S), 1):
        try:
            json.loads(bloque)
        except ValueError as e:
            errores.append(f"el JSON-LD #{i} no parsea: {e}")

    if "blog.chiletransportistas.com" in doc:
        errores.append("hay enlaces a blog.chiletransportistas.com: el blog vive en www")
    if re.search(r'href=["\'](?:https?://[^"\']*)?/articulos/', doc):
        errores.append("hay enlaces a /articulos/: esa ruta ya no existe (ahora es /transportistas/)")
    if "/blog/assets/css/styles.css" not in doc:
        errores.append('falta <link rel="stylesheet" href="/blog/assets/css/styles.css">')

    og = meta(doc, "property", "og:image") or ""
    if og != f"{CDN_BLOG}{slug}.webp":
        avisos.append(f"og:image no es la portada estándar ({CDN_BLOG}{slug}.webp)")

    art = re.search(r"<article\b.*?</article>", doc, re.S | re.I)
    cuerpo = art.group(0) if art else ""
    imgs = re.findall(r"<img\b[^>]*>", cuerpo, re.I)
    for n, img in enumerate(imgs):
        src = (re.search(r'src=["\']([^"\']+)', img) or [None, "?"])[1]
        nombre = src.rsplit("/", 1)[-1]
        if not re.search(r'\balt=["\'][^"\']{5,}["\']', img):
            errores.append(f"imagen sin alt descriptivo: {nombre}")
        if not (re.search(r"\bwidth=", img) and re.search(r"\bheight=", img)):
            avisos.append(f"imagen sin width/height (mueve el diseño al cargar): {nombre}")
        if n == 0 and 'loading="lazy"' in img:
            avisos.append("la portada tiene loading=lazy: es la imagen LCP, debe cargar de inmediato")
        if not nombre.split("?")[0].endswith((".webp", ".avif", ".svg")):
            avisos.append(f"imagen que no es WebP: {nombre}")

    internos = set(re.findall(r'href=["\'](?:%s)?(/(?:transportistas|contratar-transporte)/[a-z0-9-]+/)["\']' % re.escape(WWW), cuerpo))
    internos.discard(f"/{pista}/{slug}/")
    if len(internos) < 2:
        avisos.append(f"solo {len(internos)} enlace(s) a otros artículos del blog: apunta a 2 o más de la misma pista")

    return errores, avisos


# ---------------------------------------------------------------------------
# Tarjetas
# ---------------------------------------------------------------------------

def fecha_humana(iso):
    d = dt.date.fromisoformat(iso)
    return f"{d.day:02d} {MESES[d.month - 1]} {d.year}"


def fecha_de_tarjeta(tarjeta):
    m = re.search(r'data-fecha="(\d{4}-\d{2}-\d{2})"', tarjeta)
    if m:
        return m.group(1)
    m = re.search(r'<p class="meta"><span>(\d{1,2}) (\w{3}) (\d{4})</span>', tarjeta)
    if m and m.group(2).capitalize() in MESES:
        return f"{m.group(3)}-{MESES.index(m.group(2).capitalize()) + 1:02d}-{int(m.group(1)):02d}"
    return "0000-00-00"


def tarjeta(pista, slug, datos, etiqueta, fecha):
    titulo = html.escape(datos["titulo"], quote=True)
    alt = html.escape(datos["alt"], quote=True)
    if datos["og_image"] == f"{CDN_BLOG}{slug}.webp":
        img = (f'<img loading="lazy" decoding="async" src="{CDN_BLOG}{slug}-480.webp" '
               f'srcset="{CDN_BLOG}{slug}-480.webp 480w, {CDN_BLOG}{slug}-800.webp 800w" '
               f'sizes="(max-width: 540px) 100vw, 380px" width="480" height="252" alt="{alt}" />')
    else:
        img = f'<img loading="lazy" decoding="async" src="{html.escape(datos["og_image"])}" alt="{alt}" />'
    return f"""      <article class="card" data-fecha="{fecha}">
        <a class="stretched" href="/{pista}/{slug}/" aria-label="{titulo}"></a>
        <div class="thumb">
          {img}
        </div>
        <div class="content">
          <h3 class="title">{titulo}</h3>
          <p class="meta"><span>{fecha_humana(fecha)}</span> <span class="dot"></span> <span>{html.escape(etiqueta)}</span></p>
        </div>
      </article>
"""


RE_TARJETA = re.compile(r"[ \t]*<article class=\"card\".*?</article>\n?", re.S)


def insertar_en_grid(grid_html, nueva, href, limite=None):
    """grid_html es el contenido del <div class="grid">. Devuelve el nuevo contenido."""
    tarjetas = [t for t in RE_TARJETA.findall(grid_html) if f'href="{href}"' not in t]
    tarjetas.append(nueva)
    tarjetas.sort(key=fecha_de_tarjeta, reverse=True)
    if limite:
        tarjetas = tarjetas[:limite]
    return "\n" + "\n".join(t.rstrip("\n") + "\n" for t in tarjetas) + "\n    "


def reemplazar_grid(doc, apertura_re, nueva, href, limite=None):
    m = re.search(apertura_re + r"(.*?)(</div>\s*</section>)", doc, re.S)
    if not m:
        return None
    contenido = insertar_en_grid(m.group(2), nueva, href, limite)
    return doc[:m.start(2)] + contenido + doc[m.end(2):]


def alta_en_hub(pista, slug, nueva, fecha):
    ruta = os.path.join(RAIZ, pista, "index.html")
    with open(ruta, encoding="utf-8") as fh:
        doc = fh.read()
    href = f"/{pista}/{slug}/"
    anio = fecha[:4]

    # Si la tarjeta estaba en otro año (cambió la fecha), sácala de ahí.
    doc = re.sub(r"[ \t]*<article class=\"card\"(?:(?!</article>).)*href=\"%s\".*?</article>\n?" % re.escape(href),
                 "", doc, flags=re.S)

    marca = re.search(r"[ \t]*<!-- chtr:primer-articulo.*?-->\n", doc, re.S)
    if marca and 'class="year-filter"' not in doc:
        esqueleto = f"""  <div class="year-filter" role="tablist" aria-label="Filtrar por año">
    <span class="label">Año:</span>
    <button class="is-active" data-year="{anio}" role="tab" aria-selected="true">{anio}</button>
  </div>

  <!-- ===== {anio} ===== -->
  <section class="year-section is-visible" data-section="{anio}" aria-label="Artículos {anio}">
    <div class="grid">
    </div>
  </section>

"""
        doc = doc[:marca.start()] + esqueleto + doc[marca.end():]

    if f'data-section="{anio}"' not in doc:
        anios = [a for a in re.findall(r'data-section="(\d{4})"', doc)]
        if not anios:
            sys.exit(f"✗ {pista}/index.html no tiene secciones por año ni la marca chtr:primer-articulo")
        es_el_mas_nuevo = anio > max(anios)
        seccion = f"""  <!-- ===== {anio} ===== -->
  <section class="year-section{' is-visible' if es_el_mas_nuevo else ''}" data-section="{anio}" aria-label="Artículos {anio}">
    <div class="grid">
    </div>
  </section>

"""
        clase = ' class="is-active"' if es_el_mas_nuevo else ""
        seleccionado = "true" if es_el_mas_nuevo else "false"
        boton = (f'<button type="button"{clase} data-year="{anio}" '
                 f'role="tab" aria-selected="{seleccionado}">{anio}</button>')
        if es_el_mas_nuevo:
            doc = doc.replace('year-section is-visible"', 'year-section"')
            doc = re.sub(r'<button class="is-active" (data-year="\d{4}") role="tab" aria-selected="true">',
                         r'<button type="button" \1 role="tab" aria-selected="false">', doc)
        # Posición: antes del primer año más viejo (orden descendente)
        siguiente = next((a for a in sorted(anios, reverse=True) if a < anio), None)
        if siguiente:
            doc = re.sub(r'([ \t]*<!-- ===== %s ===== -->\n)?([ \t]*<section class="year-section[^"]*" data-section="%s")' % (siguiente, siguiente),
                         lambda m: seccion + (m.group(1) or "") + m.group(2), doc, count=1)
            doc = re.sub(r'([ \t]*)(<button[^>]*data-year="%s")' % siguiente,
                         lambda m: m.group(1) + boton + "\n" + m.group(1) + m.group(2), doc, count=1)
        else:
            ultima = list(re.finditer(r'<section class="year-section.*?</section>\n', doc, re.S))[-1]
            doc = doc[:ultima.end()] + "\n" + seccion + doc[ultima.end():]
            ultimo_boton = list(re.finditer(r'[ \t]*<button[^>]*data-year="\d{4}"[^>]*>\d{4}</button>\n', doc))[-1]
            doc = doc[:ultimo_boton.end()] + "    " + boton + "\n" + doc[ultimo_boton.end():]

    nuevo = reemplazar_grid(doc, r'(<section class="year-section[^"]*" data-section="%s"[^>]*>\s*<div class="grid">)' % anio,
                            nueva, href)
    if nuevo is None:
        sys.exit(f"✗ no encontré la grilla de {anio} en {pista}/index.html")
    doc = nuevo

    total = len(re.findall(r'<article class="card"', doc))
    aviso = None
    if pista == "contratar-transporte" and total >= 2 and 'content="noindex' in doc:
        doc = re.sub(r"\n[ \t]*<!-- ⚠️ noindex temporal:.*?-->\n[ \t]*<meta name=\"robots\" content=\"noindex, follow\">\n",
                     "\n", doc, flags=re.S)
        doc = re.sub(r'\n[ \t]*<meta name="robots" content="noindex, follow">\n', "\n", doc)
        aviso = "se quitó el noindex del hub /contratar-transporte/ (ya tiene 2 artículos)"

    with open(ruta, "w", encoding="utf-8") as fh:
        fh.write(doc)
    return total, aviso


def alta_en_portada(pista, slug, nueva):
    ruta = os.path.join(RAIZ, "blog", "index.html")
    with open(ruta, encoding="utf-8") as fh:
        doc = fh.read()
    doc = re.sub(r'(<div class="grid" data-feed="%s")\s+hidden>' % pista, r"\1>", doc)
    doc = re.sub(r'\n[ \t]*<div class="empty-state" data-vacio="%s">.*?</div>\n' % pista, "\n", doc, flags=re.S)
    nuevo = reemplazar_grid(doc, r'(<div class="grid" data-feed="%s">)' % pista, nueva, f"/{pista}/{slug}/",
                            limite=MAX_FEED_PORTADA)
    if nuevo is None:
        sys.exit(f'✗ blog/index.html no tiene <div class="grid" data-feed="{pista}">')
    with open(ruta, "w", encoding="utf-8") as fh:
        fh.write(nuevo)


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("articulo", help="ruta del artículo, p. ej. transportistas/como-cotizar-un-flete.html")
    ap.add_argument("--etiqueta", default="Guía práctica", help='texto bajo el título de la tarjeta (p. ej. "Caso de éxito")')
    ap.add_argument("--fecha", help="AAAA-MM-DD; por defecto la datePublished del JSON-LD")
    ap.add_argument("--solo-validar", action="store_true")
    a = ap.parse_args()

    rel, pista, slug, doc = leer_articulo(a.articulo)
    errores, avisos = validar(doc, pista, slug)
    datos = datos_articulo(doc, slug)

    print(f"\n{rel}\n  URL: {WWW}/{pista}/{slug}/")
    for e in errores:
        print(f"  ✗ {e}")
    for w in avisos:
        print(f"  ! {w}")
    if errores:
        print(f"\n{len(errores)} error(es): corrígelos antes de publicar.")
        return 1
    print("  ✓ estructura, SSI y SEO básicos en orden" + (" (con avisos)" if avisos else ""))
    if a.solo_validar:
        return 0

    fecha = a.fecha or datos["fecha"]
    if not fecha or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", fecha):
        print("✗ no encontré datePublished en el JSON-LD: pasa --fecha AAAA-MM-DD")
        return 1
    if not datos["titulo"]:
        print("✗ el artículo no tiene <h1>")
        return 1

    nueva = tarjeta(pista, slug, datos, a.etiqueta, fecha)
    total, aviso = alta_en_hub(pista, slug, nueva, fecha)
    alta_en_portada(pista, slug, nueva)
    print(f"  ✓ tarjeta en {pista}/index.html ({total} artículos en la pista)")
    print(f"  ✓ tarjeta en blog/index.html (feed {pista}, máx. {MAX_FEED_PORTADA})")
    if aviso:
        print(f"  ✓ {aviso}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
