#!/usr/bin/env python3
"""
Mueve el blog de blog.chiletransportistas.com a www.chiletransportistas.com.

Idempotente: se puede correr las veces que haga falta. En el repo ya se
corrió una vez (el commit trae el resultado); en el droplet se vuelve a
correr para recoger los artículos que el endpoint de publicación escribió
directo en /var/www/blog/articulos/ sin pasar por git.

Qué hace:

  1. Mueve articulos/*.html a transportistas/*.html (git mv si el archivo
     está versionado, mv si no). base-blog.html no se mueve: era una copia
     de un artículo, no una plantilla, y se borra.
  2. Reescribe en todos los .html del sitio:
       https://blog.chiletransportistas.com/articulos/X/  -> https://www.chiletransportistas.com/transportistas/X/
       /articulos/X/                                       -> /transportistas/X/
       https://blog.chiletransportistas.com/transportistas|contratar-transporte  -> https://www.chiletransportistas.com/...
       https://blog.chiletransportistas.com/  (portada)    -> https://www.chiletransportistas.com/blog/
       /assets/css|js/...                                  -> /blog/assets/css|js/...
  3. Lista lo que movió y lo que reescribió.

Uso:
    python3 deploy/migrar_a_www.py              # simulación
    python3 deploy/migrar_a_www.py --aplicar    # de verdad
    python3 deploy/migrar_a_www.py --aplicar --raiz /var/www/blog
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

WWW = "https://www.chiletransportistas.com"
VIEJO = "https://blog.chiletransportistas.com"

# Directorios que no son parte del sitio publicado.
SALTAR_DIRS = {".git", ".claude", "node_modules", "Chtr Blogs CMS", "deploy",
               "scripts", "worker", ".cache"}

# Orden importa: lo específico antes que lo general.
REGLAS = [
    # Artículos legados, con y sin dominio, con y sin .html
    (re.compile(re.escape(VIEJO) + r"/articulos/([a-z0-9-]+)(?:\.html|/)"),
     WWW + r"/transportistas/\1/"),
    (re.compile(r"(?<![\w.-])/articulos/([a-z0-9-]+)(?:\.html|/)"),
     r"/transportistas/\1/"),
    # Pistas: mismo camino, otro host
    (re.compile(re.escape(VIEJO) + r"(/(?:transportistas|contratar-transporte)\b)"),
     WWW + r"\1"),
    # Las migas de pan SSI arman la URL con #echo pegado al dominio
    (re.compile(re.escape(VIEJO) + r"(<!--#echo)"),
     WWW + r"\1"),
    # Portada, con ancla o sin ella
    (re.compile(re.escape(VIEJO) + r"/#"), WWW + "/blog/#"),
    (re.compile(re.escape(VIEJO) + r"/?(?=[\"'\s<])"), WWW + "/blog/"),
    # Estáticos propios del blog: /assets/ en www es territorio de Unicorn
    (re.compile(r"""(["'(])/assets/(css|js)/"""), r"\1/blog/assets/\2/"),
]


def git(raiz):
    # En el droplet el repo es de otro usuario (www-data) y esto corre como
    # root: sin safe.directory, git se niega a operar.
    return ["git", "-c", f"safe.directory={os.path.abspath(raiz)}"]


def es_versionado(raiz, rel):
    r = subprocess.run(git(raiz) + ["ls-files", "--error-unmatch", rel], cwd=raiz,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return r.returncode == 0


def mover(raiz, aplicar):
    origen = os.path.join(raiz, "articulos")
    destino = os.path.join(raiz, "transportistas")
    movidos = []
    if not os.path.isdir(origen):
        return movidos
    hay_git = os.path.isdir(os.path.join(raiz, ".git"))
    for nombre in sorted(os.listdir(origen)):
        if not nombre.endswith(".html"):
            continue
        rel_o = f"articulos/{nombre}"
        if nombre == "base-blog.html":
            print(f"  - {rel_o}  (copia de un artículo, no plantilla: se borra)")
            if aplicar:
                if hay_git and es_versionado(raiz, rel_o):
                    subprocess.run(git(raiz) + ["rm", "-q", rel_o], cwd=raiz, check=True)
                else:
                    os.remove(os.path.join(raiz, rel_o))
            continue
        rel_d = f"transportistas/{nombre}"
        if os.path.exists(os.path.join(raiz, rel_d)):
            print(f"  ! {rel_o}: ya existe {rel_d}, no se pisa. Revísalo a mano.")
            continue
        versionado = hay_git and es_versionado(raiz, rel_o)
        print(f"  > {rel_o} -> {rel_d}{'' if versionado else '   (NO estaba en git)'}")
        if not versionado:
            movidos.append(nombre[:-5])
        if aplicar:
            os.makedirs(destino, exist_ok=True)
            if versionado:
                subprocess.run(git(raiz) + ["mv", rel_o, rel_d], cwd=raiz, check=True)
            else:
                shutil.move(os.path.join(raiz, rel_o), os.path.join(raiz, rel_d))
    if aplicar and os.path.isdir(origen) and not os.listdir(origen):
        os.rmdir(origen)
    return movidos


def reescribir(raiz, aplicar):
    tocados = []
    for base, dirs, files in os.walk(raiz):
        dirs[:] = [d for d in dirs if d not in SALTAR_DIRS and not d.startswith(".")]
        for nombre in files:
            if not nombre.endswith(".html"):
                continue
            ruta = os.path.join(base, nombre)
            with open(ruta, encoding="utf-8", errors="surrogateescape") as fh:
                original = fh.read()
            nuevo = original
            for rx, rep in REGLAS:
                nuevo = rx.sub(rep, nuevo)
            if nuevo != original:
                tocados.append(os.path.relpath(ruta, raiz))
                if aplicar:
                    with open(ruta, "w", encoding="utf-8", errors="surrogateescape") as fh:
                        fh.write(nuevo)
    return tocados


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aplicar", action="store_true")
    ap.add_argument("--raiz", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    a = ap.parse_args()

    print(f"\n{'APLICANDO' if a.aplicar else 'SIMULACIÓN (usa --aplicar)'} en {a.raiz}\n")
    print("1. Artículos de /articulos/ a /transportistas/")
    movidos = mover(a.raiz, a.aplicar)

    print("\n2. URLs reescritas")
    tocados = reescribir(a.raiz, a.aplicar)
    for t in tocados:
        print(f"  ~ {t}")
    if not tocados:
        print("  (nada que reescribir)")

    if movidos:
        print("\nOJO: estos artículos no estaban en git: se movieron, pero no tienen tarjeta")
        print("en el hub ni en la portada. Súbelos al repo y dales de alta con")
        print("scripts/alta_articulo.py, o se perderán en el próximo despliegue limpio:")
        for s in movidos:
            print(f"  - {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
