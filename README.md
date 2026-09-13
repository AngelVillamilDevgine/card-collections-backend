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

## Cómo llega un pedido

No hay dominio para la API: no hay acceso al DNS de `devgine.com.ar`. Así que el camino
es este:

```
navegador  ──HTTPS──>  card-collections-frontend.pages.dev
                              │
                              │  Function de Pages (functions/api/[[ruta]].js)
                              │  agrega X-Dbz-Proxy y X-Forwarded-For
                              ▼
        vps-4240326-x.dattaweb.com/cartas-api   ──HTTP, SIN CIFRAR──
                              │   (puerto 80, nginx del servidor)
                              │   location /cartas-api/ -> 127.0.0.1:8081
                              │
                              ▼
                       la API  ──>  MySQL del servidor
```

El front pide `/api` sobre su propio origen, así que la Function intercepta justo esas
llamadas y **no hay CORS**: para el navegador es el mismo sitio.

**Por el nombre y no por la IP.** Cloudflare Workers rechaza los `fetch` a una IP pelada:
devuelve un 403 con "error code: 1003" que no dice nada. Por eso `DBZ_API_ORIGEN` apunta a
`vps-4240326-x.dattaweb.com`, el hostname que le da el proveedor, que resuelve al VPS. Si
Dattaweb alguna vez lo cambia, esto se rompe y hay que actualizar la variable.

**Por qué entra por el 80 y no por un puerto propio.** Hay dos listas de puertos que tienen
que coincidir, y casi no se superponen:

| | |
|---|---|
| Dattaweb deja entrar | 80, 443, 3000, 3306, 4000, 7000, 8081 |
| Cloudflare deja salir | 80, 443, 8080, 8880, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8443 |
| En las dos | **sólo 80 y 443** |

Se probaron los once puertos de Cloudflare levantando escuchas reales en el servidor:
Dattaweb los filtra todos. Así que el pedido entra por el 80, donde está nginx, y un
`location /cartas-api/` lo baja al 8081 donde escucha la API. El bloque está en
`/etc/nginx/sites-available/vps-4240326-x`, con una copia de seguridad al lado.

Es un `location` agregado a un archivo que ya existía: el `location /` quedó intacto, y se
verificó con un A/B (configuración original vs. modificada) que el sitio que ya estaba ahí
se comporta igual.

**El tramo Cloudflare → VPS va sin cifrar.** Fue una decisión tomada a sabiendas, entre
colgarse del dominio de un cliente, comprar un dominio propio, o esto. La cabecera
secreta *autentica* a la Function contra la API — sin ella se contesta 404 a todo — pero
**no cifra nada**: quien esté en el camino ve lo que pasa, claves de login incluidas.

Por eso: **la clave de esta app tiene que ser única.** Ninguna que se repita en otro lado.

Se arregla el día que haya un dominio: se le crea un registro A, Traefik le saca el
certificado solo (el router ya está puesto en el stack, esperando), se saca el `ports:`
y la Function pasa a hablarle por HTTPS — o desaparece y el front le pega directo.

## Despliegue

El VPS es **producción de Devgine con proyectos de clientes andando**. Todo lo de acá es
aditivo: un stack, dos secrets del swarm, un `location` en nginx y un timer. No toca
`edge`, `nobis-panel`, `nobis-pd-calculator` ni `supervisor-comercio`.

**Push a `main` y listo.** No hay nada más que hacer:

1. GitHub Actions corre los tests contra un MySQL 9, la misma versión del servidor.
2. En el servidor, `dbz-despliegue.timer` mira cada dos minutos el último commit de
   `main`. Si el check **Tests** de ese commit terminó bien, baja ese commit, construye
   la imagen `dbz-cromeros-api:<commit>` y le cambia la imagen al servicio.
3. Si los tests fallaron, no lo toca.

No hay secrets en GitHub, ni Docker Hub, ni claves SSH. El repo es público, así que el
servidor lee el último commit, el resultado de los tests y el código sin credenciales.
Una consulta por vuelta son 30 por hora; sin token GitHub deja 60.

El swarm actualiza con `start-first`: la versión nueva levanta y tiene que ponerse
*healthy* antes de que la anterior se apague. Si no lo logra, `failure_action: rollback`
la devuelve sola y el commit queda anotado como descartado, para no reintentarlo en cada
vuelta. El healthcheck pega contra `/api/salud`, que toca la base: un proceso vivo que no
llega al MySQL no cuenta como sano.

Después de cada deploy se borran las imágenes viejas **de este proyecto** —queda la
anterior, que es la del rollback— y la caché de build se recorta a 1 GB.

### Mirar qué pasó

```sh
journalctl -u dbz-despliegue -n 50      # qué hizo en las últimas vueltas
systemctl list-timers dbz-despliegue    # cuándo mira la próxima vez
systemctl start dbz-despliegue          # mirar ya, sin esperar
```

Un commit descartado no se reintenta. Para forzar otro intento:
`rm /var/lib/dbz-despliegue/descartado-<commit>`.

**El servidor busca el check por nombre.** Si se le cambia el `name: Tests` al job de
`.github/workflows/tests.yml`, deja de desplegar sin avisar.

### Preparar el servidor (una vez)

1. **Base, usuario y secret**, todo de una:

   ```sh
   bash infra/preparar-base.sh
   ```

   Pide la clave de root del MySQL por teclado y no la escribe en ningún lado. La del
   usuario de la app la genera sola y la deja únicamente adentro del secret. El usuario
   tiene permisos sólo sobre `dbz_cromeros`.

2. **El stack**: los comandos están en la cabecera de `infra/dbz-api.stack.yml`.

3. **El despliegue automático**:

   ```sh
   install -m 755 infra/dbz-despliegue.sh /usr/local/bin/
   install -m 644 infra/dbz-despliegue.service infra/dbz-despliegue.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now dbz-despliegue.timer
   ```

### Respaldos

No los hace esta app. La base es el MySQL compartido del servidor, así que respaldarlo
es una decisión de infraestructura, no de este proyecto. Del lado del usuario está
"Bajar una copia", que se lleva la colección entera en un `.json`.
