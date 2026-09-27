#!/usr/bin/env bash
# =============================================================================
# Migración del blog de blog.chiletransportistas.com a www.chiletransportistas.com
# Se corre UNA vez en el droplet, después de desplegar el Worker de Cloudflare
# (worker/README.md) y de hacer merge a main:
#
#   curl -fsSL https://raw.githubusercontent.com/Amonsalvek/ChileTransportistas-blog/main/deploy/migrar-a-www.sh | sudo bash
#
# Qué hace, en orden:
#   1. Respaldo completo: /var/www/blog y la config de nginx → /root/respaldos-blog/<fecha>/
#   2. Revisa que el droplet no tenga cambios locales sin versionar
#      (si los tiene se detiene; FORZAR=1 los guarda en un .patch y los descarta)
#   3. git pull de main
#   4. Mueve los artículos que queden en articulos/ (los que el endpoint de
#      publicación escribió sin pasar por git) a transportistas/ y reescribe sus URLs
#   5. Regenera sitemap-blog.xml
#   6. Instala la nueva config de nginx (con nginx -t; si falla, deja la anterior)
#   7. Instala el cron que publica lo que llegue a main cada 5 minutos
#   8. Prueba las URLs contra el nginx local y muestra el resultado
#
# Deshacer: el script imprime al final los comandos exactos.
# =============================================================================
set -euo pipefail

BLOG=${BLOG:-/var/www/blog}
RAMA=${RAMA:-main}
REPO_ESPERADO="ChileTransportistas-blog"
SITIO=/etc/nginx/sites-available/blog.chiletransportistas.com
FECHA=$(date +%Y%m%d-%H%M%S)
RESPALDO=/root/respaldos-blog/$FECHA
LOG=/var/log/chtr-blog-actualizar.log
G=(git -C "$BLOG" -c safe.directory="$BLOG")

paso() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
mal()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
ojo()  { printf '  \033[33m!\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { mal "Corre con sudo."; exit 1; }
[ -d "$BLOG/.git" ] || { mal "$BLOG no es un repositorio git."; exit 1; }
"${G[@]}" remote get-url origin | grep -q "$REPO_ESPERADO" \
  || { mal "El remoto de $BLOG no es $REPO_ESPERADO."; exit 1; }
DUENO=$(stat -c '%U' "$BLOG")
GRUPO=$(stat -c '%G' "$BLOG")

# -----------------------------------------------------------------------------
paso "1. Respaldo"
mkdir -p "$RESPALDO"
tar -czf "$RESPALDO/var-www-blog.tgz" -C "$(dirname "$BLOG")" "$(basename "$BLOG")"
[ -f "$SITIO" ] && cp -a "$SITIO" "$RESPALDO/nginx-sitio.conf"
COMMIT_ANTES=$("${G[@]}" rev-parse HEAD)
echo "$COMMIT_ANTES" > "$RESPALDO/commit-anterior"
ok "$RESPALDO ($(du -sh "$RESPALDO" | cut -f1))"

# -----------------------------------------------------------------------------
paso "2. Cambios locales en el droplet"
if [ -n "$("${G[@]}" status --porcelain --untracked-files=no)" ]; then
  "${G[@]}" diff HEAD > "$RESPALDO/cambios-locales.patch"
  "${G[@]}" status --short --untracked-files=no | sed 's/^/    /'
  if [ "${FORZAR:-0}" != "1" ]; then
    mal "Hay archivos versionados modificados en el droplet (guardados en $RESPALDO/cambios-locales.patch)."
    echo "    Revísalos. Para descartarlos y seguir:  FORZAR=1 sudo -E bash deploy/migrar-a-www.sh"
    exit 1
  fi
  "${G[@]}" reset -q --hard HEAD
  ojo "descartados (quedan en $RESPALDO/cambios-locales.patch)"
else
  ok "ninguno"
fi
SUELTOS=$("${G[@]}" ls-files --others --exclude-standard -- articulos/ || true)
if [ -n "$SUELTOS" ]; then
  ojo "artículos en articulos/ que no están en git (se moverán a transportistas/ en el paso 4):"
  echo "$SUELTOS" | sed 's/^/      /'
fi

# -----------------------------------------------------------------------------
paso "3. git pull de $RAMA"
"${G[@]}" fetch -q origin "$RAMA"
if [ "$("${G[@]}" rev-parse --abbrev-ref HEAD)" != "$RAMA" ]; then
  "${G[@]}" checkout -q "$RAMA"
fi
"${G[@]}" merge -q --ff-only "origin/$RAMA"
ok "$COMMIT_ANTES → $("${G[@]}" rev-parse HEAD)"
[ -f "$BLOG/blog/index.html" ] && [ -f "$BLOG/deploy/nginx-blog.conf" ] \
  || { mal "main todavía no tiene la migración (falta blog/index.html). ¿Hiciste merge del PR?"; exit 1; }

# -----------------------------------------------------------------------------
paso "4. Artículos sueltos de articulos/ → transportistas/"
python3 "$BLOG/deploy/migrar_a_www.py" --aplicar --raiz "$BLOG" | sed 's/^/  /'

# -----------------------------------------------------------------------------
paso "5. Sitemap"
python3 "$BLOG/update_sitemap_blog.py" --raiz "$BLOG" | head -1 | sed 's/^/  /'

chown -R "$DUENO:$GRUPO" "$BLOG"

# -----------------------------------------------------------------------------
paso "6. nginx"
bash "$BLOG/deploy/aplicar-nginx.sh" | sed 's/^/  /'

# -----------------------------------------------------------------------------
paso "7. Publicación automática (cron cada 5 minutos, usuario $DUENO)"
touch "$LOG" && chown "$DUENO:$GRUPO" "$LOG"
chmod +x "$BLOG/deploy/actualizar.sh"
cat > /etc/cron.d/chtr-blog <<EOF
# Publica en el blog lo que llegue a $RAMA. Ver $BLOG/deploy/actualizar.sh
*/5 * * * * $DUENO $BLOG/deploy/actualizar.sh >> $LOG 2>&1
EOF
chmod 644 /etc/cron.d/chtr-blog
cat > /etc/logrotate.d/chtr-blog <<EOF
$LOG {
    monthly
    rotate 6
    compress
    missingok
    notifempty
}
EOF
ok "/etc/cron.d/chtr-blog  (log: $LOG)"

# -----------------------------------------------------------------------------
paso "8. Pruebas contra el nginx local"
FALLAS=0
probar() { # esperado  ruta  [worker]
  local esperado=$1 ruta=$2 cab=()
  [ "${3:-}" = "worker" ] && cab=(-H "X-Chtr-Proxy: worker")
  local r
  r=$(curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' "${cab[@]}" \
      --resolve blog.chiletransportistas.com:443:127.0.0.1 \
      "https://blog.chiletransportistas.com$ruta" || echo "000")
  if [[ "$r" == "$esperado"* ]]; then ok "${3:+[worker] }$ruta → $r"; else mal "${3:+[worker] }$ruta → $r (esperaba $esperado)"; FALLAS=$((FALLAS+1)); fi
}
probar 200 /blog/ worker
probar 200 /blog/assets/css/blog-index.css worker
probar 200 /transportistas/ worker
probar 200 /contratar-transporte/ worker
probar 200 /sitemap-blog.xml worker
for f in "$BLOG"/transportistas/*.html "$BLOG"/contratar-transporte/*.html; do
  s=$(basename "$f" .html); p=$(basename "$(dirname "$f")")
  case "$s" in index|base-blog) continue;; esac
  probar 200 "/$p/$s/" worker
done
probar 404 /.git/config worker
probar 404 /deploy/nginx-blog.conf worker
probar "301 https://www.chiletransportistas.com/blog/" /
probar "301 https://www.chiletransportistas.com/transportistas/como-conseguir-carga-para-tu-camion/" /articulos/como-conseguir-carga-para-tu-camion/
probar "301 https://www.chiletransportistas.com/transportistas/" /transportistas/

# -----------------------------------------------------------------------------
paso "Listo"
if [ "$FALLAS" -gt 0 ]; then
  mal "$FALLAS prueba(s) fallaron. Revisa /var/log/nginx/blog_error.log"
fi
cat <<EOF

  Comprueba desde fuera (con el Worker ya desplegado):
    curl -sI https://www.chiletransportistas.com/transportistas/ | grep -iE '^(HTTP|x-chtr-origen)'
    curl -sI https://blog.chiletransportistas.com/ | grep -iE '^(HTTP|location)'

  Después, en Search Console (propiedad de www o de dominio):
    - Sitemaps → agrega  sitemap-blog.xml
    - Si tienes la propiedad blog.chiletransportistas.com: Configuración →
      Cambio de dirección → www.chiletransportistas.com

  Deshacer:
    sudo rm /etc/cron.d/chtr-blog
    sudo cp $RESPALDO/nginx-sitio.conf $SITIO && sudo nginx -t && sudo systemctl reload nginx
    sudo git -C $BLOG -c safe.directory=$BLOG reset --hard $COMMIT_ANTES
    (y quita las rutas del Worker en Cloudflare)
EOF
exit "$FALLAS"
