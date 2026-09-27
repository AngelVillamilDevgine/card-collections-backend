#!/usr/bin/env bash
# Prueba de restauración de la copia más nueva.
#
# Una copia que nunca se restauró no es una copia: es un archivo. Esto restaura la última
# en una base APARTE (dbz_restore_prueba), compara TODAS sus tablas contra la de verdad
# —filas y contenido— y después la borra. NO toca `dbz_cromeros` en ningún momento.
#
# Cuáles son «todas» sale de la base y no de una lista acá: hasta el 2026-09-27 comparó
# sólo `usuario` y `carta` y después imprimió «coinciden exactamente».
#
# CORRE SOLO, UNA VEZ POR SEMANA, y ése es el punto: hasta el 2026-09-27 había que
# acordarse de correrlo a mano, así que una copia que dejara de restaurar no la iba a
# descubrir nadie hasta el día que hiciera falta. Es el mismo agujero que el respaldo tenía
# antes de existir, un escalón más arriba: tener copias y no saber si sirven se parece
# demasiado a estar cubierto.
#
# Avisa por donde avisan las otras dos cosas que corren afuera de la app: anota en la tabla
# `salud` y el panel lo muestra. Si esto deja de correr, la fecha envejece sola y el panel
# se pone rojo — no hace falta que nada detecte la falla ni que nada logre mandar un mail,
# que en este servidor no sale.
#
# DOS FORMAS DE ENTRAR, y la diferencia es quién lo corre:
#   - el timer, sin nadie mirando: lee `/etc/dbz-respaldo.cnf`, o sea el usuario `dbz`.
#     Necesita UN permiso que hay que dar una sola vez, y el script lo dice si falta:
#       GRANT ALL PRIVILEGES ON `dbz\_restore\_prueba`.* TO 'dbz'@'localhost';
#     Acotado a esa base y nada más: no le abre al respaldo ni un permiso de la de verdad.
#   - una persona, a mano: si no hay archivo de credenciales, pide la clave de root por
#     teclado, como siempre.
#
# Correrlo a mano de vez en cuando sigue valiendo, sobre todo después de tocar el esquema:
#   scp -P 5733 infra/dbz-probar-restauracion.sh root@149.50.131.169:/tmp/ && ssh ... /tmp/...
# `-e` NO es opcional, y su ausencia era el peor defecto de este script: su UNICO
# trabajo es contestar «¿la copia sirve?» y su modo de falla devolvia la respuesta mas
# tranquilizadora posible. Con la clave mal escrita, cada consulta fallaba en silencio
# —el `2>/dev/null` de MY() se comia el error—, el `zcat | MY` fallaba, se imprimia
# «hecho» igual, las consultas de diferencias no devolvian nada porque no corrian, y la
# ultima linea decia «si no aparece ninguna linea de distintos, es que coinciden
# exactamente». Todo verde sin haber restaurado nada, y saliendo con codigo 0.
set -euo pipefail
M=mysql-db
BASE_SALUD=dbz_cromeros   # dónde vive la tabla `salud`, que es la base de verdad

# Y que se note si se corta a la mitad: sin esto, `set -e` sale callado.
trap 'echo ""; echo "FALLO en la linea $LINENO. NO se probo nada: no tomes esto como que la copia sirve." >&2' ERR

# CÓMO ENTRA A LA BASE. El archivo de credenciales es el mismo que usa el respaldo, así
# que el timer no estrena ningún secreto: si existe, se usa; si no, se pide root por
# teclado. La clave nunca va en la línea de comandos —`MYSQL_PWD` no aparece en `ps`— y
# este archivo vive en un repo PÚBLICO, así que acá no se escribe ninguna.
CREDENCIALES=/etc/dbz-respaldo.cnf
if [ -r "$CREDENCIALES" ]; then
  USUARIO=$(sed -n 's/^user=//p' "$CREDENCIALES")
  export MYSQL_PWD=$(sed -n 's/^password=//p' "$CREDENCIALES")
  SOLO=1
else
  USUARIO=root
  read -rsp "Clave de root del MySQL: " CLAVE
  echo
  export MYSQL_PWD="$CLAVE"   # así no aparece en `ps`
  unset CLAVE
  SOLO=0
fi

# El stderr YA NO se tira: era lo unico que iba a decir «access denied». Se filtra
# solamente el aviso de que la clave va por variable de entorno, que es ruido conocido.
MY() { docker exec -i -e MYSQL_PWD "$M" mysql -u"$USUARIO" "$@" 2> >(grep -v 'Using a password on the command line' >&2); }

# EL PERMISO QUE FALTA SE DICE, no se descubre leyendo un «access denied» a las tres de la
# mañana en un journal que nadie mira. Es lo único que este script necesita y que no puede
# darse a sí mismo.
if [ "$SOLO" = 1 ] && ! MY </dev/null -e "CREATE DATABASE IF NOT EXISTS dbz_restore_prueba" 2>/dev/null; then
  echo "FALTA UN PERMISO, y sin eso esto no puede probar nada. Correr una vez, como root:" >&2
  echo "  GRANT ALL PRIVILEGES ON \`dbz\\_restore\\_prueba\`.* TO '$USUARIO'@'localhost';" >&2
  exit 1
fi
COPIA=$(ls -1t /var/backups/dbz/dbz_cromeros-*.sql.gz | head -1)
echo "probando: $(basename "$COPIA")"

echo ""
echo "=== las tablas que tiene la base de verdad ==="
# SE LE PREGUNTA A LA BASE. Acá había cuatro nombres escritos a mano —usuario, carta,
# visita, sesion— y el esquema crea cinco desde que existe `salud`.
TABLAS=$(MY -N -B </dev/null -e "SHOW TABLES FROM dbz_cromeros" | sort)
echo "$TABLAS" | tr '\n' ' '
echo ""

echo ""
echo "=== restauro en dbz_restore_prueba ==="
MY </dev/null -e "DROP DATABASE IF EXISTS dbz_restore_prueba"
zcat "$COPIA" | sed 's/`dbz_cromeros`/`dbz_restore_prueba`/g' | MY
echo "  hecho"

echo ""
echo "=== tabla por tabla ==="
# QUÉ PUEDE CONTESTAR ESTE SCRIPT Y QUÉ NO.
#
# Hasta el 2026-09-27 comparó `usuario` y `carta` y después imprimió «coinciden
# exactamente». `visita` —el único lado donde vive cuánta gente vuelve—, `sesion` y
# `salud` no se miraban nunca: una copia a la que le faltara una entera salía
# certificada como buena. Eso era el defecto, y se arregla mirando TODAS, con la lista
# sacada de la base y no escrita acá.
#
# Pero el primer arreglo se pasó para el otro lado: exigía que la copia fuera IGUAL a la
# base de ahora, y eso es falso por construcción — la copia es de la madrugada y desde
# entonces cuarenta personas usaron la app. Corrido contra la copia de hoy dio
# «DIFIEREN» en las cinco tablas y dijo que la copia no servía, cuando lo único que
# pasaba es que el día transcurrió.
#
# Lo que SÍ se puede afirmar, y es lo que se verifica acá:
#   - el volcado se restaura sin errores;
#   - están TODAS las tablas que la base tiene hoy;
#   - ninguna quedó vacía si la de verdad no lo está — que es como se ve un volcado
#     cortado a la mitad.
# La deriva de filas se muestra como información, no como falla. Si alguna vez es enorme
# o negativa donde no debería, se ve de un vistazo.
FALLO=0
printf '  %-10s %10s %10s %10s\n' "tabla" "de verdad" "en la copia" "deriva"
for T in $TABLAS; do
  A=$(MY -N -B </dev/null -e "SELECT COUNT(*) FROM dbz_cromeros.\`$T\`")
  if ! B=$(MY -N -B </dev/null -e "SELECT COUNT(*) FROM dbz_restore_prueba.\`$T\`" 2>/dev/null); then
    printf '  %-10s %10s %10s   NO ESTA EN LA COPIA\n' "$T" "$A" "-"
    FALLO=1
    continue
  fi
  if [ "$A" -gt 0 ] && [ "$B" -eq 0 ]; then
    printf '  %-10s %10s %10s   VACIA EN LA COPIA\n' "$T" "$A" "$B"
    FALLO=1
    continue
  fi
  printf '  %-10s %10s %10s %10s\n' "$T" "$A" "$B" "$((A - B))"
done

echo ""
if [ "$FALLO" -eq 0 ]; then
  echo "La copia se restaura entera: estan las $(echo "$TABLAS" | grep -c .) tablas y ninguna vino vacia."
  echo "La deriva de filas es normal: la copia es de la madrugada y la app se sigue usando."
else
  echo "ESTA COPIA NO SIRVE: le falta una tabla o alguna vino vacia."
fi

echo ""
echo "=== limpio ==="
MY </dev/null -e "DROP DATABASE dbz_restore_prueba"
MY -N </dev/null -e "SHOW DATABASES LIKE 'dbz%'" | sed 's/^/  queda: /'

# SE ANOTA EN `salud`, QUE ES EL ÚNICO CANAL QUE LLEGA A LOS DOS LADOS. El correo del
# servidor rebota antes de salir, así que un aviso que dependa de mandar un mensaje no
# sirve. Acá la fecha ES el aviso: si esto deja de correr, envejece sola y el panel se
# pone rojo, sin que nada tenga que detectar nada.
#
# SÓLO SE ANOTA CUANDO LA PRUEBA PASÓ. Anotar un fracaso con la fecha de hoy dejaría el
# panel en verde con una copia que no sirve — el peor de los dos errores posibles, y
# exactamente el que este script existe para no cometer.
if [ "$FALLO" -eq 0 ]; then
  TABLAS_N=$(echo "$TABLAS" | grep -c .)
  FILAS=$(MY -N -B </dev/null -e "SELECT COUNT(*) FROM dbz_cromeros.carta" 2>/dev/null || echo 0)
  MY "$BASE_SALUD" </dev/null -e "INSERT INTO salud (clave, valor) VALUES ('restauracion',
        '{\"copia\":\"$(basename "$COPIA")\",\"tablas\":$TABLAS_N,\"cartas\":$FILAS}')
      ON DUPLICATE KEY UPDATE valor = VALUES(valor), actualizado = CURRENT_TIMESTAMP" \
    2>/dev/null || echo "  (no pude anotar la salud; la prueba igual pasó)"
fi
unset MYSQL_PWD

# Sale con codigo distinto de cero si algo no coincidio: si esto alguna vez lo corre algo
# automatico, el codigo de salida es lo unico que va a mirar.
exit "$FALLO"
