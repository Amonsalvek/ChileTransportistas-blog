#!/usr/bin/env python3
"""
Genera sitemap-blog.xml para el blog en www.chiletransportistas.com.

Se publica en https://www.chiletransportistas.com/sitemap-blog.xml (el Worker
de Cloudflare lo pide al droplet). www/robots.txt es de Unicorn, así que este
sitemap se envía a mano en Search Console una vez; después Google lo relee
solo.

Reglas:
  1. URLs con barra final y sin ".html", igual que los canonical.
  2. Los parciales SSI (navbar, footer, CTAs, banners, migas de pan) y las
     plantillas base-blog.html no son páginas: no entran.
  3. Las páginas con <meta name="robots" ... noindex> se saltan solas.
  4. blog/index.html es la portada del blog: /blog/.
  5. Cada página lleva su og:image como <image:image>: ayuda a que las
     portadas aparezcan en Google Imágenes y Discover.

Uso:
    python3 update_sitemap_blog.py                  # en el droplet
    python3 update_sitemap_blog.py --raiz . --salida /tmp/sitemap.xml
"""
import argparse
import datetime
import html
import os
import re
from xml.sax.saxutils import escape

BASE_URL = "https://www.chiletransportistas.com"

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

# Solo estas carpetas publican páginas (el resto del repo no se sirve).
PUBLICADAS = ("blog", "transportistas", "contratar-transporte")
EXCLUDED_DIRS = {"assets", "node_modules"}

NOINDEX_RE = re.compile(
    r'<meta[^>]+name=["\']robots["\'][^>]*content=["\'][^"\']*noindex', re.I
)
OG_IMAGE_RE = re.compile(
    r'<meta[^>]+property=["\']og:image["\'][^>]*content=["\']([^"\']+)["\']', re.I
)
MODIFIED_RE = re.compile(r'"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2})')


def to_url(rel_path):
    """transportistas/slug.html -> /transportistas/slug/  |  x/index.html -> /x/"""
    rel = rel_path.replace(os.sep, "/")
    if rel.endswith("/index.html"):
        return f"{BASE_URL}/{rel[:-len('index.html')]}"
    return f"{BASE_URL}/{rel[:-len('.html')]}/"


def generate_sitemap(raiz, salida):
    urls = {}
    skipped = []

    for carpeta in PUBLICADAS:
        base = os.path.join(raiz, carpeta)
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS and not d.startswith(".")]
            for name in files:
                if not name.endswith(".html"):
                    continue
                path = os.path.join(root, name)
                rel_path = os.path.relpath(path, raiz)
                if name in EXCLUDED_FILES:
                    skipped.append((rel_path, "parcial o plantilla"))
                    continue
                with open(path, encoding="utf-8", errors="replace") as fh:
                    doc = fh.read()
                if NOINDEX_RE.search(doc[:8192]):
                    skipped.append((rel_path, "noindex"))
                    continue

                # lastmod: la dateModified del JSON-LD si existe; si no, la
                # fecha del archivo (en el droplet es la del último git pull).
                m = MODIFIED_RE.search(doc)
                mod = m.group(1) if m else datetime.datetime.fromtimestamp(
                    os.path.getmtime(path), datetime.timezone.utc
                ).strftime("%Y-%m-%d")
                img = OG_IMAGE_RE.search(doc)
                urls[to_url(rel_path)] = (mod, html.unescape(img.group(1)) if img else None)

    sitemap = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    ]
    for url, (mod, img) in sorted(urls.items()):
        sitemap.append("  <url>")
        sitemap.append(f"    <loc>{escape(url)}</loc>")
        sitemap.append(f"    <lastmod>{mod}</lastmod>")
        if img:
            sitemap.append(f"    <image:image><image:loc>{escape(img)}</image:loc></image:image>")
        sitemap.append("  </url>")
    sitemap.append("</urlset>")

    tmp = salida + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(sitemap) + "\n")
    os.replace(tmp, salida)

    print(f"Sitemap actualizado: {salida} ({len(urls)} URLs)")
    for url in sorted(urls):
        print(f"  + {url}")
    for rel, why in sorted(skipped):
        print(f"  - {rel}  ({why})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--raiz", default="/var/www/blog")
    ap.add_argument("--salida", help="por defecto {raiz}/sitemap-blog.xml")
    a = ap.parse_args()
    generate_sitemap(a.raiz, a.salida or os.path.join(a.raiz, "sitemap-blog.xml"))
