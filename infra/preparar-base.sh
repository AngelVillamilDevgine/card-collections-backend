#!/usr/bin/env bash
# Crea la base, el usuario y el secret del swarm. Se corre UNA VEZ, en el servidor.
#
#   bash preparar-base.sh
#
# Pide las claves por teclado y no las escribe en ningún lado: ni en el historial,
# ni en un archivo, ni en la salida. La del usuario nuevo la genera sola.
set -euo pipefail

BASE=dbz_cromeros
USUARIO=dbz
SECRET=dbz_mysql_url
CONTENEDOR=mysql-db

[ "$(id -u)" = 0 ] || { echo "Correlo como root."; exit 1; }

# No pisar nada de lo que ya está andando.
if docker secret inspect "$SECRET" > /dev/null 2>&1; then
  echo "El secret $SECRET ya existe. Si querés rehacerlo:"
  echo "  docker service rm dbz-api_api 2>/dev/null; docker secret rm $SECRET"
  exit 1
fi

read -rsp "Clave de root del MySQL: " RAIZ; echo
[ -n "$RAIZ" ] || { echo "Sin clave no puedo seguir."; exit 1; }

# La clave del usuario de la app la genera la máquina: nadie la tipea, nadie la ve,
# y termina sólo adentro del secret.
CLAVE="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"

echo "Creando la base y el usuario…"
docker exec -i -e MYSQL_PWD="$RAIZ" "$CONTENEDOR" mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`$BASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- DOS cuentas y ninguna con '%', que es el comodín «desde cualquier lado».
--
-- El 3306 de este servidor está publicado en 0.0.0.0 y pasa la lista blanca de
-- Dattaweb, así que un usuario con host '%' es una credencial más expuesta a internet.
-- Se comprobó: con '%' la cuenta entraba desde afuera; con esto, la misma clave da
-- «Access denied for user 'dbz'@'<IP de afuera>'».
--
-- Hacen falta las dos porque se entra por dos caminos distintos:
--
--   172.%      el API, que llega por host.docker.internal, o sea 172.17.0.1. Y también
--              cualquier contenedor que le pegue a la IP pública: eso hace hairpin y
--              MySQL igual lo ve como 172.17.0.1 (medido).
--   localhost  el respaldo y el despliegue, que entran con `docker exec` por el socket
--              del contenedor. Sin ésta, el respaldo diario deja de correr.
CREATE USER IF NOT EXISTS '$USUARIO'@'172.%' IDENTIFIED BY '$CLAVE';
ALTER USER '$USUARIO'@'172.%' IDENTIFIED BY '$CLAVE';
CREATE USER IF NOT EXISTS '$USUARIO'@'localhost' IDENTIFIED BY '$CLAVE';
ALTER USER '$USUARIO'@'localhost' IDENTIFIED BY '$CLAVE';
-- Sólo sobre su base: este usuario no tiene por qué ver las de los otros proyectos.
GRANT ALL PRIVILEGES ON \`$BASE\`.* TO '$USUARIO'@'172.%';
GRANT ALL PRIVILEGES ON \`$BASE\`.* TO '$USUARIO'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "Comprobando que el usuario nuevo entra por los dos caminos…"
docker exec -i -e MYSQL_PWD="$CLAVE" "$CONTENEDOR" mysql -u"$USUARIO" -e "USE \`$BASE\`; SELECT 1" > /dev/null
echo "  entra bien."

# 172.17.0.1 es la gateway de Docker; host.docker.internal apunta ahí desde los
# servicios del swarm. Está verificado contra este servidor.
printf 'mysql://%s:%s@host.docker.internal:3306/%s' "$USUARIO" "$CLAVE" "$BASE" \
  | docker secret create "$SECRET" - > /dev/null

echo ""
echo "Listo:"
echo "  base   $BASE"
echo "  usuario $USUARIO (la clave quedó sólo adentro del secret)"
echo "  secret $SECRET"
