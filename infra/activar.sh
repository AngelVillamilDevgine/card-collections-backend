#!/usr/bin/env bash
# Pone en producción la versión que acaba de subir el deploy.
#
# La idea: cada versión vive en su propia carpeta y "actual" es un symlink. Cambiar
# de versión es mover el symlink, que es instantáneo; volver atrás es moverlo de vuelta.
# Si la versión nueva no contesta el healthcheck, se vuelve sola y el deploy falla.
set -euo pipefail

RAIZ=/opt/dbz-api
SALUD=http://127.0.0.1:8787/api/salud
INTENTOS=20
CUANTAS_GUARDO=5

: "${DBZ_SHA:?falta DBZ_SHA}"
NUEVO="$RAIZ/releases/$DBZ_SHA"
[ -d "$NUEVO" ] || { echo "No existe $NUEVO"; exit 1; }

# A dónde volver si esto sale mal. Puede no haber nada: es el primer deploy.
ANTERIOR="$(readlink -f "$RAIZ/actual" 2>/dev/null || true)"

decir() { echo "[activar] $*"; }

apuntar() {
  # ln -sfn sobre un symlink existente no es atómico: lo borra y lo crea, y en el
  # medio no hay "actual". Con mv -T el cambio es un solo paso.
  ln -sfn "$1" "$RAIZ/actual.nuevo"
  mv -Tf "$RAIZ/actual.nuevo" "$RAIZ/actual"
}

contesta() {
  for _ in $(seq 1 $INTENTOS); do
    if curl -fsS --max-time 3 "$SALUD" > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

decir "instalando dependencias de $DBZ_SHA"
cd "$NUEVO"
npm ci --omit=dev --no-audit --no-fund

decir "respaldando la base antes de tocar nada"
if [ -f "$RAIZ/datos/coleccion.db" ]; then
  node bin/respaldar.js "$RAIZ/datos/coleccion.db" "$RAIZ/respaldos" || decir "no pude respaldar (sigo)"
fi

decir "cambiando a la versión nueva"
apuntar "$NUEVO"
sudo /bin/systemctl restart dbz-api

if contesta; then
  decir "anda: $(curl -fsS $SALUD)"
else
  decir "NO contesta el healthcheck"
  if [ -n "$ANTERIOR" ] && [ -d "$ANTERIOR" ]; then
    decir "volviendo a $(basename "$ANTERIOR")"
    apuntar "$ANTERIOR"
    sudo /bin/systemctl restart dbz-api
    contesta && decir "la anterior volvió a andar" || decir "OJO: la anterior tampoco contesta"
  else
    decir "no hay versión anterior a la cual volver"
  fi
  decir "--- últimas líneas del log ---"
  sudo /bin/journalctl -u dbz-api -n 40 --no-pager || true
  exit 1
fi

# Las viejas ocupan lugar y no sirven para nada más que volver atrás: quedan unas pocas.
decir "limpiando versiones viejas"
cd "$RAIZ/releases"
ls -1dt */ 2>/dev/null | tail -n +$((CUANTAS_GUARDO + 1)) | while read -r vieja; do
  [ "$RAIZ/releases/${vieja%/}" = "$(readlink -f "$RAIZ/actual")" ] && continue
  rm -rf "${vieja%/}"
done

decir "listo"
