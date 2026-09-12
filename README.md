# API de la colección Dragon Ball Z (Cromeros)

Guarda la colección de cartas de cada usuario. El front vive en
[card-collections-frontend](https://github.com/AngelVillamilDevgine/card-collections-frontend)
y se despliega en Cloudflare; esto corre como un servicio más del swarm en el VPS.

## Correrlo local

```sh
docker run -d --name dbz-mysql -e MYSQL_ROOT_PASSWORD=prueba \
  -e MYSQL_DATABASE=dbz_cromeros -p 3307:3306 mysql:8

cp .env.example .env
npm install
npm start
npm test        # necesita el MySQL: el SQL es la mitad de lo que hay que probar
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
| `GET` | `/api/salud` | sin token; toca la base. La mira el deploy |

`PUT /api/cartas/:clave` es el camino de todos los días: un toque manda una carta y no
las 1936. Cantidad `0` borra la carta y su condición, igual que en la app.

## Cómo se guarda

MySQL, el mismo que usan los otros back del servidor. La tabla `carta` tiene
`(usuario_id, clave)` como clave primaria, así que dos personas pueden tener la misma
carta sin pisarse. No tener una carta no es una fila con un cero: es no tener fila.

La colación es `utf8mb4_unicode_ci`, que no distingue mayúsculas: "Angel" y "angel" son
el mismo usuario, y el `UNIQUE` lo impide sin normalizar nada a mano.

Las claves se guardan con scrypt. Las sesiones son un token opaco al azar, del que se
guarda el sha256: si alguien se lleva la base, no se lleva sesiones vivas. Se revoca
borrando una fila, sin esperar a que venza nada.

El esquema se crea solo al arrancar (`CREATE TABLE IF NOT EXISTS`): no hay paso de
migración aparte.

## Traer una colección de antes

```sh
node bin/importar.js angel ../datos/coleccion.json
```

Entiende las formas viejas del archivo. Si el usuario ya tiene cartas avisa y no hace
nada; para pisarlas, `DBZ_PISAR=1`.

## Despliegue

El VPS es **producción de Devgine con proyectos de clientes andando**. Todo lo de acá es
aditivo: un stack nuevo, un secret nuevo, un router nuevo en Traefik. No toca `edge`,
`nobis-panel`, `nobis-pd-calculator` ni `supervisor-comercio`.

Push a `main` → GitHub Actions corre los tests contra un MySQL de verdad, construye la
imagen, la publica, y recién ahí entra al servidor a cambiarle la imagen al servicio.

El swarm hace la actualización con `start-first`: la versión nueva levanta y tiene que
ponerse *healthy* antes de que la anterior se apague. Si no lo logra, `failure_action:
rollback` la devuelve sola. El healthcheck del contenedor pega contra `/api/salud`, que
toca la base — un proceso vivo que no llega al MySQL no cuenta como sano.

### Preparar el servidor (una vez)

1. **Base y usuario** en el MySQL que ya corre ahí:

   ```sql
   CREATE DATABASE dbz_cromeros CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'dbz'@'%' IDENTIFIED BY 'una-clave-larga';
   GRANT ALL PRIVILEGES ON dbz_cromeros.* TO 'dbz'@'%';
   ```

   Sólo sobre `dbz_cromeros`: este usuario no tiene por qué ver las bases de los otros
   proyectos.

2. **El secret** con la URL. Va como secret y no como variable porque lleva la clave:

   ```sh
   printf 'mysql://dbz:una-clave-larga@host.docker.internal:3306/dbz_cromeros' \
     | docker secret create dbz_mysql_url -
   ```

3. **El stack**:

   ```sh
   DBZ_DOMINIO=api.tudominio.com \
   DBZ_ORIGENES=https://cartas.tudominio.com \
   DBZ_IMAGEN=devgine/dbz-cromeros-api:<sha> \
     docker stack deploy -c infra/dbz-api.stack.yml --with-registry-auth dbz-api
   ```

4. **La clave del deploy**, atada a un solo comando:

   ```sh
   install -m 755 infra/dbz-deploy.sh /usr/local/bin/dbz-deploy.sh
   # y en ~/.ssh/authorized_keys:
   command="/usr/local/bin/dbz-deploy.sh",restrict ssh-ed25519 AAAA... deploy
   ```

   `command=` es lo que importa: esa clave no abre una shell ni corre otra cosa. Si se
   filtra, lo peor que puede hacer es cambiarle la imagen a este servicio — y el script
   valida que sea `devgine/dbz-cromeros-api:<tag>` y nada más.

### Secrets que necesita el workflow

| Secret | Qué es |
|---|---|
| `DOCKERHUB_USUARIO` / `DOCKERHUB_TOKEN` | para publicar la imagen |
| `SSH_CLAVE` | la privada del par de deploy |
| `SSH_HOST` · `SSH_PUERTO` · `SSH_USUARIO` | a dónde entrar |
| `SSH_HUELLA` | salida de `ssh-keyscan -p <puerto> <host>` |

`SSH_HUELLA` no es opcional: sin ella habría que aceptar cualquier host, y ahí
cualquiera que se meta en el medio se lleva el deploy.

### Respaldos

No los hace esta app. La base es el MySQL compartido del servidor, así que respaldarlo
es una decisión de infraestructura, no de este proyecto. Del lado del usuario está
"Bajar una copia", que se lleva la colección entera en un `.json`.
