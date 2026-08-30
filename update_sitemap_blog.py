#!/usr/bin/env python3
"""
Genera sitemap-blog.xml para blog.chiletransportistas.com.

Qué cambió al bifurcar el blog en dos pistas (/transportistas/ y
/contratar-transporte/):

  1. Las URLs se emiten con barra final y sin ".html", que es como el
     servidor las sirve y como están escritos los canonical. Antes el
     sitemap listaba /articulos/slug.html mientras el canonical decía
     /articulos/slug/: dos URLs distintas para la misma página.
  2. Los parciales SSI (navbar, footer, CTAs, banners, migas de pan) ya no
     entran. No son páginas: son fragmentos que el servidor inyecta.
  3. Las plantillas base-blog.html tampoco entran.
  4. Las páginas con <meta name="robots" ... noindex> se saltan solas. Así
     el hub de /contratar-transporte/ no aparece mientras esté vacío, y
     vuelve al sitemap solo cuando le quites el noindex.
  5. blog.html es la portada: se publica como la raíz del sitio.
"""
import os
import re
import datetime

BLOG_PATH   = "/var/www/blog"
BASE_URL    = "https://blog.chiletransportistas.com"
OUTPUT_FILE = os.path.join(BLOG_PATH, "sitemap-blog.xml")

# Portada del blog: se sirve en la raíz del dominio.
HOME_FILE = "blog.html"

# Parciales SSI y plantillas: fragmentos, no páginas.
EXCLUDED_FILES = {
    "navbar.html",
    "footer.html",
    "breadcrumbs.html",
    "content-cta.html",
    "content-cta-carga.html",
    "right-banner-cta.html",
    "right-banner-cta-carga.html",
    "sticky-mobile-cta.html",
    "sticky-mobile-cta-carga.html",
    "bottom-banner-blog.html",
    "base-blog.html",
}

# Directorios que nunca contienen páginas publicables.
EXCLUDED_DIRS = {".git", "assets", "deploy", "node_modules", "Chtr Blogs CMS"}

NOINDEX_RE = re.compile(
    r'<meta[^>]+name=["\']robots["\'][^>]*content=["\'][^"\']*noindex', re.I
)


def is_noindex(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return bool(NOINDEX_RE.search(fh.read(8192)))
    except OSError:
        return False


def to_url(rel_path):
    """articulos/slug.html -> /articulos/slug/   |   x/index.html -> /x/"""
    rel = rel_path.replace(os.sep, "/")
    if rel == HOME_FILE:
        return f"{BASE_URL}/"
    if rel.endswith("/index.html"):
        return f"{BASE_URL}/{rel[:-len('index.html')]}"
    if rel == "index.html":
        return f"{BASE_URL}/"
    return f"{BASE_URL}/{rel[:-len('.html')]}/"


def generate_sitemap():
    urls = {}
    skipped = []

    for root, dirs, files in os.walk(BLOG_PATH):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS and not d.startswith(".")]

        for name in files:
            if not name.endswith(".html"):
                continue

            path = os.path.join(root, name)
            rel_path = os.path.relpath(path, BLOG_PATH)

            if name in EXCLUDED_FILES:
                skipped.append((rel_path, "parcial o plantilla"))
                continue
            if is_noindex(path):
                skipped.append((rel_path, "noindex"))
                continue

            mod = datetime.datetime.fromtimestamp(
                os.path.getmtime(path), datetime.timezone.utc
            ).strftime("%Y-%m-%d")

            url = to_url(rel_path)
            # Si dos archivos resuelven a la misma URL, gana el más reciente.
            if url not in urls or mod > urls[url]:
                urls[url] = mod

    sitemap = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for url, mod in sorted(urls.items()):
        sitemap.append("  <url>")
        sitemap.append(f"    <loc>{url}</loc>")
        sitemap.append(f"    <lastmod>{mod}</lastmod>")
        sitemap.append("  </url>")
    sitemap.append("</urlset>")

    with open(OUTPUT_FILE, "w", encoding="utf-8") as fh:
        fh.write("\n".join(sitemap) + "\n")

    print(f"Sitemap actualizado: {OUTPUT_FILE} ({len(urls)} URLs)")
    for url in sorted(urls):
        print(f"  + {url}")
    for rel, why in sorted(skipped):
        print(f"  - {rel}  ({why})")


if __name__ == "__main__":
    generate_sitemap()
