#!/usr/bin/env bash
# Publica lo que llegó a main. Lo corre el cron cada 5 minutos
# (/etc/cron.d/chtr-blog, lo instala deploy/migrar-a-www.sh):
#
#   */5 * * * * <dueño de /var/www/blog> /var/www/blog/deploy/actualizar.sh >> /var/log/chtr-blog-actualizar.log 2>&1
#
# Si main no cambió, no hace nada y no escribe nada en el log.
# Si cambió: fast-forward, regenera el sitemap y avisa si cambió la
# configuración de nginx (esa se aplica a mano con deploy/aplicar-nginx.sh).
set -euo pipefail

BLOG=${BLOG:-/var/www/blog}
RAMA=${RAMA:-main}
SITIO=/etc/nginx/sites-available/blog.chiletransportistas.com
G=(git -C "$BLOG" -c safe.directory="$BLOG")
ts() { date '+%F %T'; }

exec 9>"$BLOG/.git/chtr-actualizar.lock"
flock -n 9 || exit 0

"${G[@]}" fetch -q origin "$RAMA"
antes=$("${G[@]}" rev-parse HEAD)
despues=$("${G[@]}" rev-parse "origin/$RAMA")
[ "$antes" = "$despues" ] && exit 0

if ! "${G[@]}" merge -q --ff-only "origin/$RAMA"; then
  echo "$(ts) ✗ no pude avanzar $antes → $despues. ¿Hay cambios locales en el droplet?"
  "${G[@]}" status --short | sed 's/^/    /'
  exit 1
fi

echo "$(ts) ✓ publicado $antes → $despues"
"${G[@]}" diff --name-only "$antes" "$despues" | sed 's/^/    /'

if python3 "$BLOG/update_sitemap_blog.py" --raiz "$BLOG" >/dev/null; then
  echo "$(ts)   sitemap-blog.xml regenerado"
else
  echo "$(ts) ✗ falló update_sitemap_blog.py"
fi

if [ -r "$SITIO" ] && ! cmp -s "$BLOG/deploy/nginx-blog.conf" "$SITIO"; then
  echo "$(ts) ! deploy/nginx-blog.conf cambió y NO se aplica solo: sudo bash $BLOG/deploy/aplicar-nginx.sh"
fi
