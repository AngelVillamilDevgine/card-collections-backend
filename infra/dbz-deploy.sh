#!/usr/bin/env bash
# Lo único que puede hacer la clave de GitHub Actions en este servidor.
#
# Se instala en /usr/local/bin/dbz-deploy.sh y se ata a la clave en authorized_keys:
#
#   command="/usr/local/bin/dbz-deploy.sh",restrict ssh-ed25519 AAAA... deploy
#
# Con eso, la clave no abre una shell ni corre otra cosa: entre lo que pida el cliente
# y este script, manda este script. Si la clave se filtra, lo peor que puede hacer es
# cambiarle la imagen a este servicio.
set -euo pipefail

SERVICIO=dbz-api_api
PERMITIDO='^devgine/dbz-cromeros-api:[A-Za-z0-9._-]{1,64}$'

IMAGEN="${SSH_ORIGINAL_COMMAND:-}"

if [[ ! "$IMAGEN" =~ $PERMITIDO ]]; then
  echo "Imagen rechazada: '$IMAGEN'" >&2
  echo "Sólo se acepta devgine/dbz-cromeros-api:<tag>" >&2
  exit 1
fi

echo "[deploy] actualizando $SERVICIO a $IMAGEN"

# --with-registry-auth pasa las credenciales del registry al nodo; sin eso no puede
# bajar la imagen si el repo es privado.
# El stack ya trae failure_action: rollback, así que si la nueva no se pone sana
# el swarm vuelve solo a la anterior y este comando termina en error.
docker service update \
  --image "$IMAGEN" \
  --with-registry-auth \
  --update-order start-first \
  --detach=false \
  "$SERVICIO"

echo "[deploy] estado final:"
docker service ps "$SERVICIO" --no-trunc --filter "desired-state=running" \
  --format "  {{.Name}}  {{.CurrentState}}  {{.Image}}"
