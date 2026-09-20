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
  docker exec -i "$m" mysql --defaults-extra-file=/dev/stdin dbz_cromeros <<SQL > /dev/null 2>&1 || true
$(cat "$cnf")
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

# --- 1. Qué dice GitHub del último commit ------------------------------------------
# Una sola consulta por vuelta: check-runs de main trae el SHA y el resultado de los
# tests juntos. Sin token GitHub deja 60 por hora; cada dos minutos son 30.
if ! RESP=$(curl -fsS -m 20 -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$REPO/commits/main/check-runs"); then
  decir "GitHub no contestó; pruebo en la próxima vuelta"
  exit 0
fi

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
trap 'rm -rf "$TRABAJO"' EXIT

# Sólo ese commit, sin historia. Si falla es la red: no se anota, se reintenta solo.
git -C "$TRABAJO" init -q
git -C "$TRABAJO" fetch -q --depth 1 "https://github.com/$REPO.git" "$SHA"
git -C "$TRABAJO" checkout -q FETCH_HEAD

if ! docker build -t "$IMAGEN:$CORTO" "$TRABAJO" > "$TRABAJO/build.log" 2>&1; then
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
for _ in $(seq 1 30); do
  EST=$(docker service inspect "$SERVICIO" --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}')
  case "$EST" in completed|rollback_completed|paused) break ;; esac
  sleep 2
done
QUEDO=$(imagen_de '{{.Spec.TaskTemplate.ContainerSpec.Image}}')

if [ "$QUEDO" != "$IMAGEN:$CORTO" ] || [ "$EST" != "completed" ]; then
  decir "NO quedó (estado: ${EST:-?}); el servicio sigue con $QUEDO"
  docker service ps "$SERVICIO" --format '  {{.CurrentState}} | {{.Image}} | {{.Error}}' | head -4
  touch "$ESTADO/descartado-$CORTO"
  anotar "{\"estado\":\"descartado\",\"commit\":\"$CORTO\"}"
  docker image rm "$IMAGEN:$CORTO" > /dev/null 2>&1 || true
  exit 1
fi
decir "desplegado $CORTO"
anotar "{\"estado\":\"ok\",\"commit\":\"$CORTO\"}"

# --- 4. Limpiar ---------------------------------------------------------------------
# Sólo imágenes de este proyecto, y queda la anterior: sin ella no hay rollback.
PREVIA=$(imagen_de '{{if .PreviousSpec}}{{.PreviousSpec.TaskTemplate.ContainerSpec.Image}}{{end}}')
# Un `docker image rm` falla mientras un contenedor parado siga usando esa imagen, y el
# swarm guarda los de las tareas viejas. Se borran sólo los de este servicio: los de los
# otros proyectos no se tocan.
docker ps -a --filter "name=dbz-api_api." --filter "status=exited" -q |
  xargs -r docker rm > /dev/null 2>&1 || true

docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(devgine/)?dbz-cromeros-api:' |
  while read -r img; do
    [ "$img" = "$IMAGEN:$CORTO" ] || [ "$img" = "$PREVIA" ] ||
      docker image rm "$img" > /dev/null 2>&1 || true
  done

# La caché de build crece en cada deploy y el disco está al 82%. Antes de este proyecto
# la caché del servidor estaba en cero —acá no construía nadie—, así que el tope no le
# quita nada a otro.
docker buildx prune -f --max-used-space 1gb > /dev/null 2>&1 || true
