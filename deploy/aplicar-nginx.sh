#!/usr/bin/env bash
# Instala deploy/nginx-blog.conf como server block del blog, con red de
# seguridad: respalda el actual, prueba con nginx -t y, si falla, lo restaura
# sin recargar.
#
#   sudo bash /var/www/blog/deploy/aplicar-nginx.sh
#
# No corre solo desde el cron a propósito: un cambio de configuración del
# servidor se aplica a mano, aunque venga del repo.
set -euo pipefail

BLOG=${BLOG:-/var/www/blog}
SITIO=/etc/nginx/sites-available/blog.chiletransportistas.com
ENLACE=/etc/nginx/sites-enabled/blog.chiletransportistas.com
NUEVO="$BLOG/deploy/nginx-blog.conf"
RESPALDO="${SITIO}.backup-$(date +%Y%m%d-%H%M%S)"

[ "$(id -u)" -eq 0 ] || { echo "✗ Corre con sudo."; exit 1; }
[ -f "$NUEVO" ] || { echo "✗ No existe $NUEVO"; exit 1; }

if [ -f "$SITIO" ] && cmp -s "$NUEVO" "$SITIO"; then
  echo "✓ nginx ya tiene esta configuración."
  exit 0
fi

# El respaldo va en sites-available/, NUNCA en sites-enabled/ (nginx lo
# cargaría como otro server block: "conflicting server name").
[ -f "$SITIO" ] && cp -a "$SITIO" "$RESPALDO" && echo "  respaldo: $RESPALDO"
cp "$NUEVO" "$SITIO"

# sites-enabled debe ser un symlink a sites-available.
if [ -e "$ENLACE" ] && [ ! -L "$ENLACE" ]; then
  mv "$ENLACE" "${RESPALDO}.sites-enabled"
  echo "  sites-enabled tenía una copia, no un enlace: movida a ${RESPALDO}.sites-enabled"
fi
[ -L "$ENLACE" ] || ln -s "$SITIO" "$ENLACE"

if nginx -t 2>/tmp/nginx-t.log; then
  systemctl reload nginx
  echo "✓ nginx recargado con deploy/nginx-blog.conf"
else
  cat /tmp/nginx-t.log
  if [ -f "$RESPALDO" ]; then cp -a "$RESPALDO" "$SITIO"; else rm -f "$SITIO"; fi
  echo "✗ nginx -t falló: dejé la configuración anterior (no se recargó nada)."
  exit 1
fi
