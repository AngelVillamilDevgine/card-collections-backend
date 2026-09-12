# API de la colección Dragon Ball Z (Cromeros)

Guarda la colección de cartas de cada usuario. El front vive en
[card-collections-frontend](https://github.com/AngelVillamilDevgine/card-collections-frontend)
y se despliega en Cloudflare; esto corre en el VPS.

## Correrlo local

```sh
npm install
npm start          # escucha en 127.0.0.1:8787
npm test           # los tests van contra una base en memoria
```

El front en desarrollo levanta con `npm start` en su carpeta y su proxy manda `/api` acá.

## Qué contesta

Todo lo de la colección pide `Authorization: Bearer <token>`. El `usuario_id` sale del
token, nunca de la URL: no hay forma de pedir la colección de otro.

| | | |
|---|---|---|
| `POST` | `/api/registro` | `{usuario, clave}` → `{token, usuario}` |
| `POST` | `/api/sesion` | entrar. Mismo cuerpo, misma respuesta |
| `DELETE` | `/api/sesion` | salir: borra la sesión del servidor |
| `GET` | `/api/yo` | `{usuario}`, para saber si el token guardado sirve |
| `GET` | `/api/coleccion` | `{estados, cantidades}` |
| `PUT` | `/api/cartas/:clave` | `{cantidad, estado}` — una carta sola |
| `PUT` | `/api/coleccion` | reemplaza todo. La usa "Restaurar una copia" |
| `GET` | `/api/salud` | sin token; la mira el deploy |

`PUT /api/cartas/:clave` es el camino de todos los días: un toque manda una carta y no
las 1936. Cantidad `0` borra la carta y su condición, igual que en la app.

## Cómo se guarda

SQLite. La tabla `carta` tiene `(usuario_id, clave)` como clave primaria, así que dos
personas pueden tener la misma carta sin pisarse. No tener una carta no es una fila con
un cero: es no tener fila.

Las claves se guardan con scrypt. Las sesiones son un token opaco al azar, del que se
guarda el sha256: si alguien se lleva la base, no se lleva sesiones vivas. Se revoca
borrando una fila, sin esperar a que venza nada.

## Traer una colección de antes

```sh
node bin/importar.js angel ../datos/coleccion.json
```

Entiende las formas viejas del archivo. Si el usuario ya tiene cartas avisa y no hace
nada; para pisarlas, `DBZ_PISAR=1`.

## Despliegue

Push a `main` → GitHub Actions corre los tests, y sólo si pasan sube el código por SSH.

En el servidor cada versión vive en `releases/<sha>` y `actual` es un symlink. Cambiar de
versión es mover el symlink; volver atrás es moverlo de vuelta. Si la versión nueva no
contesta `/api/salud` en 20 segundos, `activar.sh` vuelve sola a la anterior, escupe el
log y el deploy queda en rojo.

La base vive en `/opt/dbz-api/datos/`, fuera de las releases: un deploy no la toca. Se
respalda antes de cada deploy y todas las noches (14 copias).

### Preparar el servidor (una vez)

```sh
DOMINIO=api.tudominio.com CLAVE_DEPLOY="ssh-ed25519 AAAA..." bash infra/preparar-servidor.sh
```

Mira lo que ya hay antes de tocar: si hay nginx andando no lo toca, y si no hay nada en
80/443 instala Caddy, que saca y renueva el certificado solo.

### Secrets que necesita el workflow

| Secret | Qué es |
|---|---|
| `SSH_CLAVE` | la privada del par de deploy |
| `SSH_HOST` | IP o host del servidor |
| `SSH_PUERTO` | puerto de SSH |
| `SSH_USUARIO` | `dbz` |
| `SSH_HUELLA` | salida de `ssh-keyscan -p <puerto> <host>` |

`SSH_HUELLA` no es opcional: sin ella habría que aceptar cualquier host, y ahí
cualquiera que se meta en el medio se lleva el deploy.
