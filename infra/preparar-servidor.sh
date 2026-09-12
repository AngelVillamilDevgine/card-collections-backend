#!/usr/bin/env bash
# Prepara el servidor para recibir deploys. Se corre UNA VEZ, como root.
#
#   DOMINIO=api.tudominio.com CLAVE_DEPLOY="ssh-ed25519 AAAA..." bash preparar-servidor.sh
#
# El servidor ya tiene otras cosas andando, así que esto mira antes de tocar:
# no instala un proxy si ya hay uno, y no pisa configuración que no escribió él.
set -euo pipefail

RAIZ=/opt/dbz-api
USUARIO=dbz
PUERTO_API=8787

: "${CLAVE_DEPLOY:?falta CLAVE_DEPLOY (la pública de GitHub Actions)}"
DOMINIO="${DOMINIO:-}"

decir()  { echo -e "\n[preparar] $*"; }
aviso()  { echo "  ! $*"; }
[ "$(id -u)" = 0 ] || { echo "Correlo como root."; exit 1; }

# ---------------------------------------------------------------- qué hay ahora
decir "qué hay en el servidor"
echo "  $(. /etc/os-release && echo "$PRETTY_NAME")  ·  $(uname -m)  ·  $(nproc) cpus"
echo "  node: $(command -v node > /dev/null && node -v || echo 'no está')"
for s in nginx caddy apache2 httpd docker; do
  command -v "$s" > /dev/null && echo "  ya instalado: $s"
done
echo "  escuchando en 80/443:"
ss -lntp 2>/dev/null | awk 'NR==1 || $4 ~ /:(80|443)$/' | sed 's/^/    /'

if ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE ":$PUERTO_API\$"; then
  aviso "algo ya escucha en $PUERTO_API. Cambiá PORT en $RAIZ/.env antes de seguir."
  exit 1
fi

# -------------------------------------------------------------------- node 22
decir "node"
NECESITA_NODE=1
if command -v node > /dev/null; then
  MAYOR=$(node -p 'process.versions.node.split(".")[0]')
  [ "$MAYOR" -ge 20 ] && { NECESITA_NODE=0; echo "  node $(node -v) sirve, no lo toco"; }
  [ "$NECESITA_NODE" = 1 ] && aviso "node $(node -v) es viejo; instalo el 22 al lado"
fi
if [ "$NECESITA_NODE" = 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
# better-sqlite3 baja binario ya compilado; si no hay para esta plataforma, lo compila.
apt-get install -y --no-install-recommends build-essential python3 rsync curl > /dev/null

# -------------------------------------------------------------------- usuario
decir "usuario $USUARIO"
if id "$USUARIO" > /dev/null 2>&1; then
  echo "  ya existe"
else
  # Sin shell de login y sin home propio: sólo corre el servicio y recibe el deploy.
  useradd --system --create-home --home-dir "$RAIZ" --shell /bin/bash "$USUARIO"
  echo "  creado"
fi

mkdir -p "$RAIZ"/{releases,datos,respaldos} "$RAIZ/.ssh"
chown -R "$USUARIO:$USUARIO" "$RAIZ"
chmod 700 "$RAIZ/.ssh" "$RAIZ/datos"

# ------------------------------------------------------------ clave del deploy
decir "clave de GitHub Actions"
AUTH="$RAIZ/.ssh/authorized_keys"
touch "$AUTH"
if grep -qF "$CLAVE_DEPLOY" "$AUTH"; then
  echo "  ya estaba"
else
  # restrict apaga port-forwarding, agent-forwarding y pty: esta clave sólo sirve
  # para copiar archivos y correr el activar.sh, no para pasear por la red interna.
  echo "restrict,pty $CLAVE_DEPLOY" >> "$AUTH"
  echo "  agregada"
fi
chown "$USUARIO:$USUARIO" "$AUTH"; chmod 600 "$AUTH"

# ------------------------------------------------------- lo que puede hacer dbz
decir "permisos de sudo (sólo lo justo)"
cat > /etc/sudoers.d/dbz-api <<SUDO
# El deploy necesita reiniciar su servicio y leer su log. Nada más.
dbz ALL=(root) NOPASSWD: /bin/systemctl restart dbz-api, /bin/systemctl status dbz-api, /bin/journalctl -u dbz-api *
SUDO
chmod 440 /etc/sudoers.d/dbz-api
visudo -c -f /etc/sudoers.d/dbz-api

# -------------------------------------------------------------------- config
decir "configuración"
if [ -f "$RAIZ/.env" ]; then
  echo "  .env ya existe, no lo piso"
else
  cat > "$RAIZ/.env" <<ENV
PORT=$PUERTO_API
DBZ_DIRECCION=127.0.0.1
DBZ_BASE=$RAIZ/datos/coleccion.db
DBZ_ORIGENES=${ORIGENES:-https://card-collections-frontend.pages.dev}
DBZ_LOG=info
ENV
  echo "  .env escrito — revisá DBZ_ORIGENES cuando sepas la URL del front"
fi
chown "$USUARIO:$USUARIO" "$RAIZ/.env"; chmod 600 "$RAIZ/.env"

install -m 755 -o root -g root "$(dirname "$0")/activar.sh" "$RAIZ/activar.sh"
install -m 644 "$(dirname "$0")/dbz-api.service" /etc/systemd/system/dbz-api.service

# -------------------------------------------------------- respaldo todas las noches
decir "respaldo diario"
cat > /etc/systemd/system/dbz-respaldo.service <<UNIT
[Unit]
Description=Respaldo de la colección
[Service]
Type=oneshot
User=$USUARIO
WorkingDirectory=$RAIZ/actual
ExecStart=/usr/bin/node bin/respaldar.js $RAIZ/datos/coleccion.db $RAIZ/respaldos 14
UNIT
cat > /etc/systemd/system/dbz-respaldo.timer <<UNIT
[Unit]
Description=Respaldar la colección todos los días
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable dbz-api > /dev/null
systemctl enable --now dbz-respaldo.timer > /dev/null
echo "  el servicio queda habilitado; arranca con el primer deploy"

# ---------------------------------------------------------------------- proxy
decir "proxy y HTTPS"
if [ -z "$DOMINIO" ]; then
  aviso "sin DOMINIO no configuro el proxy. La API queda en 127.0.0.1:$PUERTO_API."
elif command -v nginx > /dev/null && systemctl is-active --quiet nginx; then
  aviso "hay nginx andando: no lo toco. Agregale a mano un server para $DOMINIO con"
  aviso "  proxy_pass http://127.0.0.1:$PUERTO_API;"
elif command -v caddy > /dev/null || ! ss -lnt | awk '{print $4}' | grep -qE ':(80|443)$'; then
  if ! command -v caddy > /dev/null; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update && apt-get install -y caddy
  fi
  BLOQUE="/etc/caddy/dbz-api.caddy"
  cat > "$BLOQUE" <<CADDY
# La API. Caddy saca y renueva el certificado solo.
$DOMINIO {
	reverse_proxy 127.0.0.1:$PUERTO_API
}
CADDY
  grep -qF "import dbz-api.caddy" /etc/caddy/Caddyfile 2>/dev/null \
    || echo "import dbz-api.caddy" >> /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
  echo "  Caddy sirviendo $DOMINIO -> 127.0.0.1:$PUERTO_API"
else
  aviso "hay algo en 80/443 que no es nginx ni caddy. Configurá el proxy a mano."
fi

decir "listo"
echo "  Falta: apuntar $DOMINIO a este servidor en el DNS, y pushear a main."
