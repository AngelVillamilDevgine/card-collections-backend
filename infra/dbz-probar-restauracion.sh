#!/usr/bin/env bash
# Prueba de restauración de la copia más nueva.
#
# Una copia que nunca se restauró no es una copia: es un archivo. Esto restaura la última
# en una base APARTE (dbz_restore_prueba), compara fila por fila contra la de verdad y
# después la borra. NO toca `dbz_cromeros` en ningún momento.
#
# Correrlo de vez en cuando, y sobre todo después de tocar el esquema:
#   scp -P 5733 infra/dbz-probar-restauracion.sh root@149.50.131.169:/tmp/ && ssh ... /tmp/...
#
# Usa root del MySQL porque hay que crear y borrar una base: el usuario `dbz` sólo tiene
# permisos sobre la suya. Por eso NO se instala como servicio ni queda en la máquina.
set -uo pipefail
M=mysql-db

# La clave se pide por teclado y no se escribe en ningún lado: este archivo vive en un
# repo PÚBLICO. `read -rsp` tampoco la deja en el historial del shell.
read -rsp "Clave de root del MySQL: " CLAVE
echo
export MYSQL_PWD="$CLAVE"   # así no aparece en `ps`
unset CLAVE

MY() { docker exec -i -e MYSQL_PWD "$M" mysql -uroot "$@" 2>/dev/null; }
COPIA=$(ls -1t /var/backups/dbz/dbz_cromeros-*.sql.gz | head -1)
echo "probando: $(basename "$COPIA")"

echo ""
echo "=== la base de verdad, ahora ==="
MY -N </dev/null -e "
SELECT CONCAT('  usuario: ', (SELECT COUNT(*) FROM dbz_cromeros.usuario)),
       CONCAT('carta: ',     (SELECT COUNT(*) FROM dbz_cromeros.carta)),
       CONCAT('visita: ',    (SELECT COUNT(*) FROM dbz_cromeros.visita)),
       CONCAT('sesion: ',    (SELECT COUNT(*) FROM dbz_cromeros.sesion))"

echo ""
echo "=== restauro en dbz_restore_prueba ==="
MY </dev/null -e "DROP DATABASE IF EXISTS dbz_restore_prueba"
zcat "$COPIA" | sed 's/`dbz_cromeros`/`dbz_restore_prueba`/g' | MY
echo "  hecho"

echo ""
echo "=== lo que quedó en la restaurada ==="
MY -N </dev/null -e "
SELECT CONCAT('  usuario: ', (SELECT COUNT(*) FROM dbz_restore_prueba.usuario)),
       CONCAT('carta: ',     (SELECT COUNT(*) FROM dbz_restore_prueba.carta)),
       CONCAT('visita: ',    (SELECT COUNT(*) FROM dbz_restore_prueba.visita)),
       CONCAT('sesion: ',    (SELECT COUNT(*) FROM dbz_restore_prueba.sesion))"

echo ""
echo "=== diferencias reales, fila por fila ==="
MY -N </dev/null -e "
SELECT CONCAT('  usuarios distintos: ', COUNT(*)) FROM (
  SELECT id,usuario,hash,creado FROM dbz_cromeros.usuario
  UNION ALL SELECT id,usuario,hash,creado FROM dbz_restore_prueba.usuario) t
GROUP BY id,usuario,hash,creado HAVING COUNT(*)<>2"
MY -N </dev/null -e "
SELECT CONCAT('  cartas distintas: ', COUNT(*)) FROM (
  SELECT usuario_id,clave,cantidad,estado FROM dbz_cromeros.carta
  UNION ALL SELECT usuario_id,clave,cantidad,estado FROM dbz_restore_prueba.carta) t
GROUP BY usuario_id,clave,cantidad,estado HAVING COUNT(*)<>2"
echo "  (si no aparece ninguna linea de 'distintos', es que coinciden exactamente)"

echo ""
echo "=== limpio ==="
MY </dev/null -e "DROP DATABASE dbz_restore_prueba"
MY -N </dev/null -e "SHOW DATABASES LIKE 'dbz%'" | sed 's/^/  queda: /'
