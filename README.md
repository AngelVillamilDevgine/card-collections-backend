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
node bin/import-collection.js angel ../datos/coleccion.json
```

Entiende las formas viejas del archivo. Si el usuario ya tiene cartas avisa y no hace
nada; para pisarlas, `DBZ_PISAR=1`.

## Cómo llega un pedido

El navegador le pega **directo** a `https://api.cromeros.com.ar`. No hay intermediarios.

```
navegador  ──HTTPS──>  api.cromeros.com.ar
                              │   Cloudflare (DNS proxeado, modo Full)
                              ▼
                       Traefik en el 443 del VPS
                              │   red `proxy` del swarm
                              ▼
                       la API  ──>  MySQL del servidor
```

El front vive en `https://cromeros.com.ar` (Cloudflare Pages) y la API en un subdominio,
así que **sí hay CORS**: el dominio del front tiene que estar en `DBZ_ORIGENES` o el
navegador corta todo, y el error aparece del lado del front como si fuera un bug de ahí.

El certificado del origen lo pone Traefik con su autofirmado, y Cloudflare lo acepta
porque la zona está en modo **Full** — cifra, pero no valida el origen. Para *Full
(strict)* habría que meterle un certificado propio a Traefik, y eso obliga a tocar el
stack `edge`, que es de los clientes.

El router del stack va con `tls=true` y **sin** `certresolver`: el resolver `le` usa
credenciales de la cuenta de Devgine y no puede validar un dominio de Angel.

### Lo que había antes, para no reinventarlo

Hasta el 2026-09-18, sin dominio propio, el camino era: el front pedía `/api` a sí mismo,
una Function de Pages lo reenviaba al VPS **por HTTP sin cifrar** agregando una cabecera
secreta, y entraba por un `location` de nginx al puerto 8081. Todo eso se fue cuando Angel
compró `cromeros.com.ar`. **Nada de eso existe ya**: ni la Function, ni la cabecera
secreta, ni el `location` de nginx, ni el puerto publicado.

Dos cosas de entonces que conviene no reinventar:

- **Cloudflare Workers no hace `fetch` a una IP pelada**: devuelve un 403 con
  `error code: 1003` que no explica nada. Y sólo sale por ciertos puertos (80, 443, 8080,
  8880, 2052…), que casi no se cruzan con los que deja entrar Dattaweb (80, 443, 3000,
  3306, 4000, 7000, 8081). En las dos listas estaban **sólo el 80 y el 443**.
- **El 8081 estaba ocupado y `ss` no lo decía.** El ingress del swarm intercepta el
  tráfico externo con iptables antes de que llegue al socket, así que el puerto se veía
  libre y en realidad `/etc/nginx/sites-enabled/nobis` lo tenía para el frontend de un
  cliente. Del 12 al 18 de septiembre, quien entrara desde afuera a ese puerto caía en
  esta API en vez del sitio del cliente.

## Despliegue

**El Dockerfile lo aprueba el servidor.** Es el único archivo de este repo que se ejecuta
con privilegios en la máquina —como root, y desde una red que alcanza las bases de los
clientes—, así que no se toma del commit a ciegas: el servidor guarda la huella del que
aprobó en `/etc/dbz-dockerfile.sha256` y, si la del commit no es esa, **no construye y
avisa**. Cambiar el Dockerfile es entonces dos pasos, a propósito:

```
    # 1. pushear el cambio como siempre
    # 2. en el servidor, después de mirarlo:
    sha256sum Dockerfile | cut -d' ' -f1 > /etc/dbz-dockerfile.sha256
```

Mientras tanto el deploy queda parado y el panel de números lo muestra.


El VPS es **producción de Devgine con proyectos de clientes andando**. Todo lo de acá es
aditivo: un stack, dos secrets del swarm, un `location` en nginx y un timer. No toca
`edge`, `nobis-panel`, `nobis-pd-calculator` ni `supervisor-comercio`.

**Push a `main` y listo.** No hay nada más que hacer:

1. GitHub Actions corre los tests contra un MySQL 9, la misma versión del servidor.
2. En el servidor, `dbz-despliegue.timer` mira **cada cinco minutos** el último commit de
   `main`. Si el check **Tests** de ese commit terminó bien, baja ese commit, construye
   la imagen `dbz-cromeros-api:<commit>` y le cambia la imagen al servicio.
3. Si los tests fallaron, no lo toca.

No hay secrets en GitHub, ni Docker Hub, ni claves SSH. El repo es público, así que el
servidor lee el último commit, el resultado de los tests y el código sin credenciales.
Una consulta por vuelta son **12 por hora**; sin token GitHub deja 60, y son **por IP**,
o sea compartidas con todo lo que corre en el VPS. Con dos minutos este timer se comía 30
de 60 él solo, y si otro proceso de la máquina consultaba GitHub se quedaban los dos sin
nada. Por eso pasó a cinco.

El swarm actualiza con `start-first`: la versión nueva levanta y tiene que ponerse
*healthy* antes de que la anterior se apague. Si no lo logra, `failure_action: rollback`
la devuelve sola y el commit queda anotado como descartado, para no reintentarlo en cada
vuelta. El healthcheck pega contra `/api/salud`, que toca la base: un proceso vivo que no
llega al MySQL no cuenta como sano.

Después de cada deploy se borran las imágenes viejas **de este proyecto** —quedan la
actual y las dos más nuevas, para poder volver—. La caché de build **no** se recorta a un
tamaño: se poda **por antigüedad** (lo de más de una semana) y **sólo cuando quedan menos
de 6 GB libres**. `buildx prune` es global y no se puede filtrar por proyecto, así que un
tope de tamaño le borraría la caché a cualquiera que construya en esta máquina; lo más
viejo es lo que menos le duele a nadie.

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

4. **El respaldo diario.** Este paso faltaba hasta el 2026-09-27, y no es un detalle:
   siguiendo los tres pasos de arriba el servidor quedaba andando **y sin ninguna copia
   de la base**. La sección de más abajo describía el respaldo como si se instalara solo.

   ```sh
   install -m 750 infra/dbz-respaldo.sh /usr/local/bin/
   install -m 644 infra/dbz-respaldo.service infra/dbz-respaldo.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now dbz-respaldo.timer
   ```

   Y las credenciales, que **no** son las de root del MySQL: el usuario `dbz`, el mismo
   que usa la API, cuya clave vive en el secret `dbz_mysql_url` del swarm. Un secret no
   se puede leer con `docker secret inspect`: hay que montarlo en algo.

   ```sh
   docker service create --name leer-dbz --restart-condition none --secret dbz_mysql_url \
     alpine sh -c 'sed -n "s|.*://dbz:\([^@]*\)@.*|\1|p" /run/secrets/dbz_mysql_url'
   docker service logs leer-dbz     # ahí sale la clave
   docker service rm leer-dbz

   printf '[client]\nuser=dbz\npassword=%s\n' '<la clave de arriba>' > /etc/dbz-respaldo.cnf
   chmod 600 /etc/dbz-respaldo.cnf
   ```

   El archivo va `0600` y sólo-root porque es lo único que separa a quien entre a la
   máquina de la base de las cartas. Y va por `--defaults-extra-file` en vez de en la
   línea de comandos: si no, la clave aparece en `ps` para cualquiera.

   Para comprobar que quedó: `systemctl start dbz-respaldo && journalctl -u dbz-respaldo -n 5`.
   Tiene que decir cuántas tablas guardó y que son *todas las que tiene la base*.

5. **La prueba de restauración, que corre sola una vez por semana.** Tener copias no es lo
   mismo que poder restaurarlas, y hasta el 2026-09-27 esto había que acordarse de
   correrlo a mano: una copia que dejara de restaurar no la descubría nadie hasta el día
   que hiciera falta.

   ```sh
   install -m 750 infra/dbz-probar-restauracion.sh /usr/local/bin/
   install -m 644 infra/dbz-restauracion.service infra/dbz-restauracion.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now dbz-restauracion.timer
   ```

   Y **un permiso, una sola vez**, porque hay que crear una base aparte y el usuario `dbz`
   sólo tiene la suya. Va acotado a la base de descarte: no le abre nada de la de verdad
   ni de las de los clientes.

   ```sql
   GRANT ALL PRIVILEGES ON `dbz\_restore\_prueba`.* TO 'dbz'@'localhost';
   ```

   Si falta, el script lo dice y sale con error — no se queda en silencio. Para
   comprobarlo: `systemctl start dbz-restauracion && journalctl -u dbz-restauracion -n 20`.
   Tiene que terminar en «La copia se restaura entera».

### Respaldos

Una copia por día de `dbz_cromeros`, y **sólo de esa base**: no toca las de los otros
proyectos del servidor ni nada más de la máquina.

| | |
|---|---|
| Qué | `infra/dbz-respaldo.sh`, que corre `dbz-respaldo.timer` una vez por día |
| Dónde | `/var/backups/dbz/dbz_cromeros-<fecha>.sql.gz`, sólo root (700 la carpeta, 600 los archivos) |
| Cuánto | 20 KB por copia. Se guardan 30 días: 600 KB en total |
| Con qué credenciales | el usuario `dbz`, desde `/etc/dbz-respaldo.cnf` (sólo root). **No** las de root del MySQL, que es compartido |
| Log | `journalctl -u dbz-respaldo` |

El volcado se escribe como `.parcial` y recién se le pone el nombre bueno si pasa un
control: que pese más de 5 KB y que traiga **todas** las tablas. **Un archivo vacío o a
medias es peor que no tener nada**, porque parece que hay copia y no hay.

Cuáles son «todas» **se le pregunta a la base**, no está escrito en el script. Acá decía
«las cuatro tablas» y el esquema crea cinco desde que existe `salud` — le agregaron una
el mismo día que nació el respaldo y el número nunca se subió, así que un volcado al que
le faltara una tabla entera pasaba el control. Probado sacándole `visita` a una copia
real: el control viejo la aceptaba, el nuevo la rechaza y dice cuál falta.

**Probar la restauración es parte del trabajo, no un extra.** Está
`infra/dbz-probar-restauracion.sh`: restaura la copia más nueva en una base aparte,
comprueba que estén **todas** las tablas y que ninguna vino vacía, y la borra. No toca
`dbz_cromeros`. Pide la clave de root por teclado, porque hay que crear una base y este
repo es público.

**Lo que ese script puede afirmar y lo que no.** Hasta el 2026-09-27 comparó `usuario` y
`carta` y después imprimía «coinciden exactamente»: `visita`, `sesion` y `salud` no se
miraban nunca. Pero exigir que la copia sea **igual** a la base tampoco sirve — la copia
es de la madrugada y desde entonces la app se usó, así que diferir es lo normal. Hoy
afirma sólo lo comprobable: que el volcado se restaura sin errores, que están todas las
tablas, y que ninguna quedó vacía si la de verdad no lo está — que es como se ve un
volcado cortado a la mitad. La deriva de filas se muestra como información.

Corrido el 2026-09-27 sobre la copia del día: las cinco tablas presentes, ninguna vacía,
y la deriva esperable (`carta` +10 por las cartas cargadas en el día, `usuario` −3 por
tres cuentas de prueba borradas a mano).

Los pasos para restaurar de verdad están al final de `infra/dbz-respaldo.sh`.

**Lo que esto NO cubre:** las copias viven en el mismo disco que la base. Protegen de un
`DELETE` mal hecho, de un bug o de un borrado accidental — que son los casos más
probables — pero no de perder el VPS. El destino externo se puede agregar después sin
rehacer nada.

Del lado del usuario está "Bajar una copia", que se lleva su colección en un `.json`.
