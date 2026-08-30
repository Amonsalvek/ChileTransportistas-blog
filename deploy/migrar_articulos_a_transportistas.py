#!/usr/bin/env python3
"""
Migración en un solo lote de /articulos/ a /transportistas/.

NO CORRER TODAVÍA. Ver MIGRACION-PISTAS.md: la migración espera a que haya
lectura estable de la intervención de cama baja. Mover URLs mientras el sitio
sigue demotado mezcla el ruido del 301 con el ruido de julio y deja las dos
mediciones inservibles.

Qué hace, en este orden:

  1. git mv de cada articulos/*.html a transportistas/*.html
     (base-blog.html se queda: ya existe la plantilla de la pista).
  2. Reescribe en TODO el repo los enlaces /articulos/{slug}/ a
     /transportistas/{slug}/, incluidos canonical, og:url y mainEntityOfPage.
  3. Imprime el bloque `map` de nginx listo para pegar, con una línea por
     artículo migrado.

Uso:
    python3 deploy/migrar_articulos_a_transportistas.py            # simulación
    python3 deploy/migrar_articulos_a_transportistas.py --aplicar  # de verdad

Después de aplicar:
  - Descomenta el bloque de migración de nginx-blog-pistas.conf con el map
    que imprime este script, y recarga nginx.
  - Corre update_sitemap_blog.py en el droplet.
  - Reenvía el sitemap en Search Console y deja /articulos/ en el informe de
    redirecciones hasta que Google reprocese: no lo quites del sitemap viejo
    antes de tiempo.
"""
import argparse
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORIGEN  = "articulos"
DESTINO = "transportistas"

# Plantillas: no son artículos publicados y cada pista ya tiene la suya.
NO_MIGRAR = {"base-blog.html"}

# Directorios que no se tocan al reescribir enlaces.
SALTAR_DIRS = {".git", "node_modules", "assets", "Chtr Blogs CMS"}


def run(cmd, aplicar):
    print("    $ " + " ".join(cmd))
    if aplicar:
        subprocess.run(cmd, cwd=REPO, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aplicar", action="store_true",
                    help="ejecuta los cambios (por defecto solo simula)")
    args = ap.parse_args()
    aplicar = args.aplicar

    origen_dir = os.path.join(REPO, ORIGEN)
    if not os.path.isdir(origen_dir):
        sys.exit(f"No existe {origen_dir}: ¿ya migraste?")

    slugs = sorted(
        f[:-len(".html")]
        for f in os.listdir(origen_dir)
        if f.endswith(".html") and f not in NO_MIGRAR
    )
    if not slugs:
        sys.exit("No hay artículos que migrar.")

    print(f"\n{'APLICANDO' if aplicar else 'SIMULACIÓN (usa --aplicar)'} — "
          f"{len(slugs)} artículos\n")

    # --- 1. mover archivos -------------------------------------------------
    print("1. Mover archivos")
    os.makedirs(os.path.join(REPO, DESTINO), exist_ok=True)
    for slug in slugs:
        run(["git", "mv",
             f"{ORIGEN}/{slug}.html",
             f"{DESTINO}/{slug}.html"], aplicar)

    # --- 2. reescribir enlaces --------------------------------------------
    print("\n2. Reescribir enlaces internos")
    patrones = [(re.compile(re.escape(f"/{ORIGEN}/{s}/")), f"/{DESTINO}/{s}/")
                for s in slugs]
    tocados = 0
    for root, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in SALTAR_DIRS]
        for name in files:
            if not name.endswith((".html", ".xml", ".py", ".md")):
                continue
            path = os.path.join(root, name)
            with open(path, encoding="utf-8", errors="replace") as fh:
                original = fh.read()
            nuevo = original
            for rx, rep in patrones:
                nuevo = rx.sub(rep, nuevo)
            if nuevo != original:
                tocados += 1
                rel = os.path.relpath(path, REPO)
                print(f"    ~ {rel}")
                if aplicar:
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write(nuevo)
    print(f"    {tocados} archivos con enlaces actualizados")

    # --- 3. map de nginx ---------------------------------------------------
    ancho = max(len(s) for s in slugs) + len(f"/{ORIGEN}//") + 2
    print("\n3. Pegar en nginx, a nivel http (fuera del server block):\n")
    print("map $uri $articulo_legacy {")
    print(f'    {"default":<{ancho}} "";')
    for slug in slugs:
        print(f"    {'/' + ORIGEN + '/' + slug + '/':<{ancho}} "
              f"/{DESTINO}/{slug}/;")
    print("}")

    if not aplicar:
        print("\nNada se modificó. Repite con --aplicar cuando toque.")


if __name__ == "__main__":
    main()
