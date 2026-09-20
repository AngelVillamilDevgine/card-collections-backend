#!/usr/bin/env bash
# Copia diaria de la base de las cartas.
#
# SÓLO de `dbz_cromeros`: las cuatro tablas de este proyecto (usuario, carta, sesion,
# visita). No toca las bases de los otros proyectos del servidor, ni MongoDB, ni nada
# más de la máquina.
#
# La corre dbz-respaldo.timer, una vez por día. Log: journalctl -u dbz-respaldo
#
# Hasta el 2026-09-20 no había ninguna copia de nada: ni timer, ni cron, ni un .sql en
# el disco. Un `docker volume rm` de más, un DELETE mal hecho o perder el VPS se llevaba
# las cuentas y las colecciones de todos, sin vuelta.
#
# Para restaurar, ver el final de este archivo.
set -euo pipefail

BASE=dbz_cromeros
DESTINO=/var/backups/dbz
DIAS=30                          # cuántos días de copias se guardan
TABLAS_ESPERADAS=4
MINIMO=5000                      # bytes; el volcado real ronda los 20 KB
CREDENCIALES=/etc/dbz-respaldo.cnf

decir() { echo "[respaldo] $*"; }

# Las credenciales NO están en este script. Viven en un archivo sólo-root, y son las del
# usuario `dbz`, que sólo tiene permisos sobre esta base — no las de root del MySQL, que
# es compartido con los proyectos de clientes.
if [ ! -r "$CREDENCIALES" ]; then
  decir "falta $CREDENCIALES; no puedo entrar a la base"
  exit 1
fi

# El MySQL es un contenedor suelto, no un servicio del swarm.
MYSQL=$(docker ps --filter name=mysql --format '{{.Names}}' | head -1)
if [ -z "$MYSQL" ]; then
  decir "no encontré el contenedor de MySQL andando"
  exit 1
fi

mkdir -p "$DESTINO"
chmod 700 "$DESTINO"

ARCHIVO="$DESTINO/$BASE-$(date +%F).sql.gz"
PARCIAL="$ARCHIVO.parcial"
ERRORES=$(mktemp)
trap 'rm -f "$ERRORES" "$PARCIAL"' EXIT INT TERM

# --defaults-extra-file por stdin: así la clave no aparece nunca en la línea de comandos,
#   que cualquiera puede ver con `ps`.
# --single-transaction: consistente sin trabar las tablas, que la app está usando en vivo.
# --no-tablespaces: si no, pediría el privilegio PROCESS, que el usuario `dbz` no tiene
#   ni tiene por qué tener.
if ! docker exec -i "$MYSQL" mysqldump \
       --defaults-extra-file=/dev/stdin \
       --single-transaction --no-tablespaces --routines --triggers \
       --databases "$BASE" < "$CREDENCIALES" 2>"$ERRORES" | gzip -9 > "$PARCIAL"; then
  decir "mysqldump falló:"
  tail -5 "$ERRORES"
  exit 1
fi

# Que el volcado SIRVA, no sólo que exista. Un archivo vacío o cortado a la mitad es peor
# que no tener nada: parece que hay copia, y no hay. Por eso se escribe como .parcial y
# recién se le pone el nombre bueno si pasa el control.
TAMANO=$(stat -c%s "$PARCIAL")
TABLAS=$(zcat "$PARCIAL" | grep -c '^CREATE TABLE' || true)
if [ "$TAMANO" -lt "$MINIMO" ] || [ "$TABLAS" -lt "$TABLAS_ESPERADAS" ]; then
  decir "el volcado no sirve: $TAMANO bytes y $TABLAS tablas (esperaba $TABLAS_ESPERADAS). No lo guardo."
  exit 1
fi

mv "$PARCIAL" "$ARCHIVO"
chmod 600 "$ARCHIVO"
decir "guardado $(basename "$ARCHIVO") · $TAMANO bytes · $TABLAS tablas"

# Se borran las viejas, y sólo las de este proyecto: el patrón del nombre las acota.
BORRADAS=$(find "$DESTINO" -maxdepth 1 -name "$BASE-*.sql.gz" -mtime +"$DIAS" -print -delete | wc -l)
if [ "$BORRADAS" -gt 0 ]; then
  decir "borré $BORRADAS copias de más de $DIAS días"
fi

QUEDAN=$(find "$DESTINO" -maxdepth 1 -name "$BASE-*.sql.gz" | wc -l)
decir "quedan $QUEDAN copias, $(du -sh "$DESTINO" | cut -f1) en total"

# Se deja anotado EN LA BASE que la copia salió bien, para que el panel de números lo
# muestre. Es el único canal que llega a los dos lados: el correo del servidor no sale
# (rebota antes de llegar a Gmail). Si esto deja de correr, la fecha se pone vieja sola
# y eso mismo es el aviso.
# La clave va por MYSQL_PWD y no por --defaults-extra-file: ese lee TODA la entrada
# estándar como configuración, así que el SQL que viene después se le mezclaría. Y
# `-e MYSQL_PWD` sin valor la toma del entorno, así que tampoco aparece en `ps`.
USUARIO_BASE=$(sed -n 's/^user=//p' "$CREDENCIALES")
export MYSQL_PWD=$(sed -n 's/^password=//p' "$CREDENCIALES")
docker exec -i -e MYSQL_PWD "$MYSQL" mysql -u"$USUARIO_BASE" "$BASE" <<SQL 2>/dev/null   || decir "no pude anotar la salud (la copia igual está)"
INSERT INTO salud (clave, valor) VALUES ('respaldo', '{"bytes":$TAMANO,"copias":$QUEDAN}')
  ON DUPLICATE KEY UPDATE valor = VALUES(valor), actualizado = CURRENT_TIMESTAMP;
SQL
unset MYSQL_PWD

# ----------------------------------------------------------------------------------
# RESTAURAR
#
# El volcado trae su propio CREATE DATABASE y sus DROP TABLE: reemplaza la base ENTERA.
# Por eso el paso 2 no es opcional.
#
#   1. Ver qué copias hay:
#        ls -lh /var/backups/dbz
#
#   2. Probarla en una base aparte, SIN tocar la de verdad:
#        zcat /var/backups/dbz/dbz_cromeros-<fecha>.sql.gz \
#          | sed 's/`dbz_cromeros`/`dbz_restore_prueba`/g' \
#          | docker exec -i mysql-db mysql --defaults-extra-file=/etc/dbz-respaldo.cnf
#      ...y contar que esté todo:
#        docker exec -i mysql-db mysql --defaults-extra-file=/etc/dbz-respaldo.cnf \
#          -e 'SELECT COUNT(*) FROM dbz_restore_prueba.usuario'
#
#      (el usuario `dbz` sólo tiene permisos sobre dbz_cromeros, así que para esta prueba
#       hay que crear la base y darle permisos, o usar root)
#
#   3. Recién si eso dio bien, encima de la de verdad:
#        zcat /var/backups/dbz/dbz_cromeros-<fecha>.sql.gz \
#          | docker exec -i mysql-db mysql -uroot -p
#
#   4. Reiniciar la API para que suelte las conexiones viejas:
#        docker service update --force dbz-api_api
