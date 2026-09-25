#!/usr/bin/env bash
# Despliega sola la API cuando aparece un commit nuevo en main con los tests en verde.
#
# La corre dbz-despliegue.timer cada dos minutos. No usa ningún secreto: el repo es
# público, así que ver el último commit, saber si pasaron sus tests y bajar el código
# se hace sin credenciales. Por eso no hay Docker Hub ni claves SSH en GitHub.
#
# Se instala en /usr/local/bin/. El log: journalctl -u dbz-despliegue
set -euo pipefail

REPO=AngelVillamilDevgine/card-collections-backend
SERVICIO=dbz-api_api
IMAGEN=dbz-cromeros-api
CHECK=Tests            # el name del job en .github/workflows/tests.yml
ESTADO=/var/lib/dbz-despliegue
# MB libres sin los cuales no se construye (ver abajo). En MB y no en GB porque
# `df -BG` redondea para ARRIBA: con 8.2G libres dice 9G, y el margen real quedaba
# hasta un giga por debajo de lo que uno cree estar exigiendo.
DISCO_MINIMO_MB=3072
# La huella del Dockerfile que ESTE SERVIDOR aprobó. Ver más abajo por qué existe.
REFERENCIA_DOCKERFILE=/etc/dbz-dockerfile.sha256
# Cuántas vueltas de 3 s se espera a que el swarm se asiente antes de decidir.
#
# El techo eran 60 s y los deploys reales tardan 51, 52, 53 y 55 — el margen era de
# cinco segundos. Y la cuenta dice que tenía que pasar: con start-first, el healthcheck
# del Dockerfile (start-period 20 s, hasta 3 intentos cada 15 s) y el `monitor: 30s` del
# stack, lo normal son entre 55 y 75 segundos. El 2026-09-13 se pasó, y ver más abajo lo
# que hacía entonces. Cinco minutos no le cuesta nada a nadie: sólo se agotan cuando
# algo está mal de verdad, y systemd no arranca dos corridas de la misma unidad a la vez.
VUELTAS_CONVERGENCIA=100

decir() { echo "[despliegue] $*"; }

# Deja anotado en la base cómo le fue, para que el panel de números lo muestre. Cuando
# esto falla no se entera nadie: el correo del servidor no sale (rebota antes de llegar a
# Gmail), y nadie mira /var/lib/dbz-despliegue. La base sí la ven los dos lados.
# Es best-effort: si no puede anotar, no se cae el despliegue por eso.
anotar() {
  local cnf=/etc/dbz-respaldo.cnf
  [ -r "$cnf" ] || return 0
  local m
  m=$(docker ps --filter name=mysql --format '{{.Names}}' | head -1) || return 0
  [ -n "$m" ] || return 0
  # La clave va por MYSQL_PWD y no por --defaults-extra-file: ese lee TODA la entrada
  # estándar como configuración, así que el SQL que viene después se le mezclaría. Y
  # `-e MYSQL_PWD` sin valor la toma del entorno, así que tampoco aparece en `ps`.
  local u
  u=$(sed -n 's/^user=//p' "$cnf")
  MYSQL_PWD=$(sed -n 's/^password=//p' "$cnf")   docker exec -i -e MYSQL_PWD "$m" mysql -u"$u" dbz_cromeros <<SQL > /dev/null 2>&1 || true
INSERT INTO salud (clave, valor) VALUES ('despliegue', '$1')
  ON DUPLICATE KEY UPDATE valor = VALUES(valor), actualizado = CURRENT_TIMESTAMP;
SQL
}

mkdir -p "$ESTADO"

# Un commit descartado no se reintenta nunca más. Eso está bien para los tests en rojo
# —no se van a poner verdes solos— pero no para un fallo PASAJERO: un `npm ci` con el
# registry lento dejaba los despliegues congelados en silencio, y para siempre, porque
# nadie mira este archivo. A las 24 horas se olvida y se vuelve a intentar.
find "$ESTADO" -maxdepth 1 -name 'descartado-*' -mmin +1440 -print -delete 2>/dev/null   | while read -r viejo; do decir "olvido $(basename "$viejo"): hace más de un día que se descartó"; done

# La imagen de una spec, sin el @sha256:… que el swarm a veces le pega al final.
imagen_de() {
  local v
  v=$(docker service inspect "$SERVICIO" --format "$1" 2>/dev/null) || return 0
  echo "${v%@*}"
}

# ¿Hay una tarea CORRIENDO con la imagen nueva? Es lo único que no miente cuando el
# UpdateStatus se queda pensando.
tarea_viva() {
  docker service ps "$SERVICIO" --filter desired-state=running       --format '{{.CurrentState}}|{{.Image}}' 2>/dev/null |
    grep -q "^Running.*|${IMAGEN}:${CORTO}\(@\|$\)"
}

# --- 1. Qué dice GitHub del último commit ------------------------------------------
# Una sola consulta por vuelta: check-runs de main trae el SHA y el resultado de los
# tests juntos.
# La cuota de la API de GitHub sin token son 60 por hora y es POR IP: la comparte
# todo el VPS. Este timer se comía la mitad él solo, y si otro proceso de la máquina
# consultaba GitHub se quedaban los dos sin nada y los deploys se congelaban hasta
# una hora, en silencio.
#
# Lo primero que se probó fue mandar el ETag para que GitHub conteste 304. NO SIRVE:
# se midió contra la API de verdad y los 304 gastan cuota igual cuando no hay token
# (cuatro seguidos bajaron el contador de 49 a 46). La documentación dice que los 304
# no cuentan, y para pedidos sin autenticar es falso. Así que el arreglo es otro:
#
#   - el timer pasa de 2 a 5 minutos, o sea de 30 llamadas por hora a 12;
#   - y cuando la cuota QUE COMPARTE TODA LA MÁQUINA baja del piso, este script se
#     corre solo hasta que se renueva, en vez de correr a gastarla antes que el otro.
#     Se anota la hora de renovación y no se vuelve a llamar hasta entonces.
CUOTA_MINIMA=15
PAUSA="$ESTADO/github-pausa"
if [ -s "$PAUSA" ] && [ "$(date +%s)" -lt "$(cat "$PAUSA" 2>/dev/null || echo 0)" ]; then
  exit 0   # callado a propósito: si no, llena el journal cada cinco minutos
fi

CAB=$(mktemp); CUERPO=$(mktemp)
# Trap desde ya: este bloque tiene varias salidas tempranas y sin esto dejaba dos
# temporales tirados en cada una.
trap 'rm -f "$CAB" "$CUERPO"' EXIT

CODIGO=$(curl -sS -m 20 -o "$CUERPO" -D "$CAB" -w '%{http_code}' \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$REPO/commits/main/check-runs" || echo 000)

# Las cabeceras de cuota vienen igual en el 200 y en el 403.
limite() { sed -n "s/^[Xx]-[Rr]ate[Ll]imit-$1: *//p" "$CAB" | tr -d '\r' | head -1; }
QUEDAN=$(limite Remaining)
VUELVE=$(limite Reset)
cuando() { date -d "@$1" '+%H:%M' 2>/dev/null || echo "$1"; }

# Si la cuota compartida quedó baja, se anota hasta cuándo no molestar más.
if [ -n "$QUEDAN" ] && [ -n "$VUELVE" ] && [ "$QUEDAN" -le "$CUOTA_MINIMA" ]; then
  echo "$VUELVE" > "$PAUSA"
  decir "quedan $QUEDAN llamadas a GitHub para TODO el servidor: no consulto hasta las $(cuando "$VUELVE")"
fi

case "$CODIGO" in
  200)
    RESP=$(cat "$CUERPO")
    ;;
  403|429)
    if [ "${QUEDAN:-1}" = "0" ] && [ -n "$VUELVE" ]; then
      decir "cuota de GitHub agotada; vuelve a las $(cuando "$VUELVE")"
    else
      decir "GitHub contestó $CODIGO; pruebo en la próxima vuelta"
    fi
    exit 0
    ;;
  *)
    decir "GitHub no contestó ($CODIGO); pruebo en la próxima vuelta"
    exit 0
    ;;
esac

read -r SHA RESULTADO < <(printf '%s' "$RESP" | CHECK="$CHECK" python3 -c '
import json, os, sys
runs = [r for r in json.load(sys.stdin).get("check_runs", []) if r.get("name") == os.environ["CHECK"]]
if not runs:
    print("- sin-tests"); sys.exit()
r = max(runs, key=lambda r: r.get("started_at") or "")   # si lo re-corrieron, el último
print(r["head_sha"], r["conclusion"] if r["status"] == "completed" else "corriendo")
')

[ "$RESULTADO" = "sin-tests" ] && exit 0   # recién pusheado: Actions todavía no arrancó
[ "$RESULTADO" = "corriendo" ] && exit 0

CORTO=${SHA:0:12}
ACTUAL=$(imagen_de '{{.Spec.TaskTemplate.ContainerSpec.Image}}')

[ "$ACTUAL" = "$IMAGEN:$CORTO" ] && exit 0        # ya está desplegado
[ -e "$ESTADO/descartado-$CORTO" ] && exit 0      # ya se intentó y no anduvo

if [ "$RESULTADO" != "success" ]; then
  # Se anota para no repetir el aviso cada dos minutos hasta el próximo commit.
  decir "los tests de $CORTO dieron '$RESULTADO': no se despliega"
  touch "$ESTADO/descartado-$CORTO"
  anotar "{\"estado\":\"descartado\",\"commit\":\"$CORTO\"}"
  exit 0
fi

# --- 2. Construir -------------------------------------------------------------------
decir "commit nuevo con los tests en verde: $CORTO (hoy corre $ACTUAL)"

# Con poco disco no se construye, y no es por cuidar este proyecto: un build que llena
# el disco deja sin poder escribir al MySQL que comparten los proyectos de clientes, y
# InnoDB con el disco lleno se pone en sólo lectura o se corrompe. La diferencia es
# entre "hoy no despliego" y "se corrompió la base de un cliente".
#
# No se anota como descartado: en cuanto haya lugar, se reintenta solo en la próxima
# vuelta del timer.
LIBRE=$(df --output=avail -BM /var/lib/docker | tail -1 | tr -dc '0-9')
if [ "${LIBRE:-0}" -lt "$DISCO_MINIMO_MB" ]; then
  decir "quedan ${LIBRE}M libres y hacen falta ${DISCO_MINIMO_MB}M: no construyo. Se reintenta solo."
  exit 0
fi

TRABAJO=$(mktemp -d)
# Un solo trap EXIT manda: el segundo pisa al primero. Por eso este limpia también
# los temporales de la consulta a GitHub, que si no quedaban tirados en /tmp uno por
# deploy y para siempre.
trap 'rm -rf "$TRABAJO" "$CAB" "$CUERPO"' EXIT

# Sólo ese commit, sin historia. Si falla es la red: no se anota, se reintenta solo.
git -C "$TRABAJO" init -q
git -C "$TRABAJO" fetch -q --depth 1 "https://github.com/$REPO.git" "$SHA"
git -C "$TRABAJO" checkout -q FETCH_HEAD

# --- 2b. El Dockerfile lo pone el servidor, no el commit --------------------------
#
# Hasta acá, un push a main con los tests en verde hacía que este servidor ejecutara el
# Dockerfile de ese commit. Medido el 2026-09-25 con un build de prueba, lo que eso da:
#
#     quien soy en el build:  0:root
#     alcanza el MySQL de los clientes en 172.17.0.1:3306
#     y también el MongoDB
#     y tiene internet
#
# O sea que un `RUN` cualquiera en un Dockerfile corría como root con acceso a las bases
# de los clientes. El radio de explosión de una cuenta de GitHub comprometida no era esta
# app: era el servidor entero.
#
# Aislar la red del build no alcanza: se probó, `--network=none` efectivamente corta el
# acceso al 3306, pero nuestro build necesita internet para el `npm ci`. Lo que sí cierra
# el agujero es que el Dockerfile no venga de afuera. Si el del commit no es exactamente
# el que este servidor tiene aprobado, no se construye: se avisa y se para.
#
# Lo que eso cuesta: cambiar el Dockerfile ya no es sólo pushear, hay que aprobar la
# huella nueva en el servidor. Es a propósito — es el único archivo del repo que se
# ejecuta con privilegios acá, y que un humano lo mire una vez es exactamente la
# propiedad que se busca. Para aprobarlo:
#
#     sha256sum Dockerfile | cut -d' ' -f1 > /etc/dbz-dockerfile.sha256
#
# Lo que NO cierra: una dependencia comprometida sigue llegando al contenedor y corriendo
# ahí en tiempo de ejecución. Eso se acota con `--ignore-scripts` en el `npm ci` (no
# ejecuta nada al instalar) y, sobre todo, cerrando el MySQL compartido, que es el #1.
if [ ! -s "$REFERENCIA_DOCKERFILE" ]; then
  decir "falta $REFERENCIA_DOCKERFILE: no sé qué Dockerfile está aprobado, así que no construyo"
  decir "  se aprueba con: sha256sum Dockerfile | cut -d' ' -f1 > $REFERENCIA_DOCKERFILE"
  anotar "{\"estado\":\"sin-referencia\",\"commit\":\"$CORTO\"}"
  exit 1
fi

HUELLA=$(sha256sum "$TRABAJO/Dockerfile" 2>/dev/null | cut -d' ' -f1)
APROBADA=$(tr -d ' \n\r' < "$REFERENCIA_DOCKERFILE")
if [ "$HUELLA" != "$APROBADA" ]; then
  decir "el Dockerfile de $CORTO NO es el que este servidor aprobó: no construyo"
  decir "  aprobado: $APROBADA"
  decir "  el del commit: ${HUELLA:-sin Dockerfile}"
  decir "  si el cambio es tuyo y lo revisaste: sha256sum Dockerfile | cut -d' ' -f1 > $REFERENCIA_DOCKERFILE"
  # Se descarta para no repetir el aviso cada cinco minutos. La marca caduca a las 24
  # horas, así que si nadie lo aprueba, mañana vuelve a decirlo.
  touch "$ESTADO/descartado-$CORTO"
  anotar "{\"estado\":\"dockerfile-sin-aprobar\",\"commit\":\"$CORTO\"}"
  exit 1
fi

# --pull: `node:22-alpine` es un tag MÓVIL. Sin esto se sigue construyendo para
# siempre sobre la copia local del día que se bajó por primera vez, con los CVE de
# ese día, por más deploys que se hagan — y dos builds del mismo commit pueden dar
# runtimes distintos. Es lo único que mantiene parcheado el sistema operativo del
# contenedor. Si Docker Hub no contesta, el build falla, NO se anota como descartado
# y se reintenta solo en la próxima vuelta.
if ! docker build --pull -t "$IMAGEN:$CORTO" "$TRABAJO" > "$TRABAJO/build.log" 2>&1; then
  decir "no construyó; se descarta $CORTO. Últimas líneas:"
  tail -20 "$TRABAJO/build.log"
  touch "$ESTADO/descartado-$CORTO"
  anotar "{\"estado\":\"descartado\",\"commit\":\"$CORTO\"}"
  exit 1
fi

# --- 3. Desplegar -------------------------------------------------------------------
# --no-resolve-image: la imagen existe sólo en esta máquina; sin eso el swarm la va a
# buscar a Docker Hub, no la encuentra y rechaza la tarea.
# El stack trae start-first y failure_action: rollback. El código de salida de este
# comando no es confiable para saber si quedó, así que se comprueba abajo.
# --env-add: /api/salud contesta con DBZ_VERSION. Sin esto seguiría mostrando la versión
# del primer stack deploy aunque adentro corra otra.
decir "actualizando el servicio"
docker service update --image "$IMAGEN:$CORTO" --no-resolve-image \
  --env-add "DBZ_VERSION=$IMAGEN:$CORTO" \
  --update-order start-first --detach=false --quiet "$SERVICIO" || true

# El swarm tarda un momento en pasar de "updating" a "completed". Leerlo de una hace
# que un deploy bueno parezca fallado, y entonces el commit queda descartado, la unidad
# sale con error y no se limpian las imágenes viejas. Se espera a que se asiente.
for _ in $(seq 1 "$VUELTAS_CONVERGENCIA"); do
  EST=$(docker service inspect "$SERVICIO" --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}')
  case "$EST" in completed|rollback_completed|paused) break ;; esac
  sleep 3
done
QUEDO=$(imagen_de '{{.Spec.TaskTemplate.ContainerSpec.Image}}')

# Que el UpdateStatus siga en "updating" no quiere decir que haya fallado: puede estar
# lento. Antes de darlo por perdido se mira si la tarea nueva está corriendo.
#
# Esto no es una precaución teórica. El 2026-09-13 el script dijo «NO quedó (estado:
# updating)» y en el renglón siguiente, en su propio diagnóstico, imprimió
# «Running 30 seconds ago | dbz-cromeros-api:46c0e793cdf4»: el deploy había salido bien
# y la prueba estaba ahí impresa. La ignoraba.
if [ "$EST" != "completed" ] && [ "$QUEDO" = "$IMAGEN:$CORTO" ] && tarea_viva; then
  decir "el swarm todavía dice '${EST:-?}', pero la tarea nueva ya corre: lo doy por bueno"
  EST=completed
fi

if [ "$QUEDO" != "$IMAGEN:$CORTO" ] || [ "$EST" != "completed" ]; then
  decir "NO quedó (estado: ${EST:-?}); el servicio sigue con $QUEDO"
  docker service ps "$SERVICIO" --format '  {{.CurrentState}} | {{.Image}} | {{.Error}}' | head -4
  touch "$ESTADO/descartado-$CORTO"
  anotar "{\"estado\":\"descartado\",\"commit\":\"$CORTO\"}"
  # NUNCA borrar la imagen a la que apunta la spec del servicio, haya fallado o no.
  # Esta imagen no está en ningún registry: existe sólo en esta máquina. Borrarle el tag
  # mientras el servicio la tiene en su spec no rompe nada en el momento —el contenedor
  # ya está andando y la retiene por id— pero al siguiente reinicio el swarm va a buscar
  # una imagen que no existe en ninguna parte y la tarea queda rechazada para siempre.
  # Y nadie se entera hasta ese reinicio, que puede ser días después.
  if [ "$QUEDO" != "$IMAGEN:$CORTO" ]; then
    docker image rm "$IMAGEN:$CORTO" > /dev/null 2>&1 || true
  else
    decir "no borro $IMAGEN:$CORTO: es la que el servicio tiene puesta"
  fi
  exit 1
fi
decir "desplegado $CORTO"
anotar "{\"estado\":\"ok\",\"commit\":\"$CORTO\"}"

# --- 4. Limpiar ---------------------------------------------------------------------
# Sólo imágenes de este proyecto, y quedan las últimas: sin ellas no hay rollback.
#
# `PreviousSpec` NO alcanza para saber cuál es la anterior: queda vacío después de un
# `docker stack deploy` a mano, y entonces esto borraba TODAS menos la actual, incluida
# la única a la que se podía volver. El rollback del swarm quedaba apuntando a una
# imagen que ya no existía en ninguna parte — y no está en ningún registry, así que no
# hay de dónde bajarla de nuevo.
#
# Ahora se guarda por fecha: la actual siempre, más las dos más nuevas después de
# ella. No depende de que el swarm recuerde nada.
PREVIA=$(imagen_de '{{if .PreviousSpec}}{{.PreviousSpec.TaskTemplate.ContainerSpec.Image}}{{end}}')
# Un `docker image rm` falla mientras un contenedor parado siga usando esa imagen, y el
# swarm guarda los de las tareas viejas. Se borran sólo los de este servicio: los de los
# otros proyectos no se tocan.
docker ps -a --filter "name=dbz-api_api." --filter "status=exited" -q |
  xargs -r docker rm > /dev/null 2>&1 || true

GUARDAR=$(mktemp)
{ echo "$IMAGEN:$CORTO"
  [ -n "$PREVIA" ] && echo "$PREVIA"
  # Las más nuevas primero, sin contar la actual: con dos alcanza para tener a dónde volver.
  docker images --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' |
    grep -E 'dbz-cromeros-api:' | sort -r | cut -f2 |
    grep -v -x "$IMAGEN:$CORTO" | head -2
} | sort -u > "$GUARDAR"

docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(devgine/)?dbz-cromeros-api:' |
  while read -r img; do
    grep -q -x "$img" "$GUARDAR" || docker image rm "$img" > /dev/null 2>&1 || true
  done
decir "imágenes que quedan: $(tr '\n' ' ' < "$GUARDAR")"
rm -f "$GUARDAR"

# La caché de build crece en cada deploy y el disco está al 83%. Pero `buildx prune` es
# GLOBAL: no se puede filtrar por proyecto, así que un `--max-used-space 1gb` le borra
# la caché a cualquiera que construya en esta máquina. Hoy no le quita nada a nadie
# porque nadie más construye acá; deja de ser cierto el día que alguien lo haga, y ese
# día nadie va a relacionar sus builds lentos con este timer.
#
# Dos cambios para que eso no pase: sólo se poda cuando el disco está de verdad
# apretado, y se poda por ANTIGÜEDAD en vez de por tamaño — lo más viejo es lo que
# menos le duele a cualquiera, y nunca toca la caché de un build reciente de otro.
#
# Para aislarlo del todo habría que darle a este proyecto su propio builder
# (`docker buildx create --name dbz`) y podar sólo ése, y eso deja un contenedor
# buildkit corriendo para siempre en una máquina de 5.8 GB compartida. Se deja
# anotado y no se hace hasta que haya otro proyecto construyendo acá.
LIBRE_AHORA=$(df --output=avail -BM /var/lib/docker | tail -1 | tr -dc '0-9')
if [ "${LIBRE_AHORA:-999999}" -lt $((DISCO_MINIMO_MB * 2)) ]; then
  decir "quedan ${LIBRE_AHORA}M libres: podo la caché de build de más de una semana"
  docker buildx prune -f --filter 'until=168h' > /dev/null 2>&1 || true
fi
