// La base: el MySQL que ya corre en el servidor, el mismo que usan los otros back.
//
// Una sola tabla de cartas para todos: lo que separa una colección de otra es la
// columna usuario_id, que está en la clave primaria.
import fs from 'node:fs'
import mysql from 'mysql2/promise'

// utf8mb4_unicode_ci no distingue mayúsculas, así que "Angel" y "angel" son el mismo
// usuario y el UNIQUE de abajo lo impide sin tener que normalizar nada a mano.
const COLACION = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'

const TABLAS = [
  `CREATE TABLE IF NOT EXISTS usuario (
     id       INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     usuario  VARCHAR(64)  NOT NULL,
     hash     VARCHAR(255) NOT NULL,
     creado   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     UNIQUE KEY usuario_unico (usuario)
   ) ${COLACION}`,

  // Se guarda el sha256 del token, no el token: si alguien se lleva la base, no se
  // lleva sesiones vivas.
  `CREATE TABLE IF NOT EXISTS sesion (
     hash       CHAR(64)     NOT NULL PRIMARY KEY,
     usuario_id INT UNSIGNED NOT NULL,
     creado     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
     vence      DATETIME     NOT NULL,
     KEY sesion_por_usuario (usuario_id),
     KEY sesion_por_vencimiento (vence),
     CONSTRAINT sesion_de_usuario FOREIGN KEY (usuario_id)
       REFERENCES usuario(id) ON DELETE CASCADE
   ) ${COLACION}`,

  // Un día en que el usuario usó la app. Sirve para lo único que importa saber:
  // cuántos vuelven. Antes se miraba `sesion`, pero una sesión dura 30 días, así que
  // el que entra una vez y la usa todos los días figuraba como que no volvió nunca.
  /* Cómo le fue a lo que corre FUERA de la app: el respaldo diario y el despliegue.
     Esos dos viven en el servidor, no acá, y cuando fallan no se entera nadie — el
     correo del VPS no llega a Gmail (probado: rebota), así que no hay a dónde avisar.
     La base sí la ven los dos lados, así que se usa de canal: ellos escriben acá y el
     panel de números lo muestra. Si algo deja de correr, la fecha se pone vieja sola y
     eso mismo es el aviso. */
  `CREATE TABLE IF NOT EXISTS salud (
     clave       VARCHAR(40) NOT NULL PRIMARY KEY,
     valor       TEXT        NOT NULL,
     actualizado TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   ) ${COLACION}`,

  `CREATE TABLE IF NOT EXISTS visita (
     usuario_id INT UNSIGNED NOT NULL,
     dia        DATE         NOT NULL,
     app        TINYINT UNSIGNED NOT NULL DEFAULT 0,
     PRIMARY KEY (usuario_id, dia),
     KEY visita_por_dia (dia),
     CONSTRAINT visita_de_usuario FOREIGN KEY (usuario_id)
       REFERENCES usuario(id) ON DELETE CASCADE
   ) ${COLACION}`,

  // No tener una carta no es una fila con un cero: es no tener fila.
  `CREATE TABLE IF NOT EXISTS carta (
     usuario_id INT UNSIGNED     NOT NULL,
     clave      VARCHAR(40)      NOT NULL,
     cantidad   SMALLINT UNSIGNED NOT NULL,
     estado     VARCHAR(12)      NULL,
     -- Cuándo se tocó por última vez. Ver addMarkedAt() para por qué existe y por qué
     -- las filas anteriores a la migración quedan en NULL.
     marked_at  TIMESTAMP        NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (usuario_id, clave),
     CONSTRAINT carta_de_usuario FOREIGN KEY (usuario_id)
       REFERENCES usuario(id) ON DELETE CASCADE
   ) ${COLACION}`,
]

/* La URL lleva la contraseña del MySQL, así que en producción no viaja como variable
   de entorno sino como secret del swarm, que Docker deja en un archivo. */
export function urlDeConexion() {
  const archivo = process.env.DBZ_MYSQL_URL_FILE
  if (archivo) return fs.readFileSync(archivo, 'utf8').trim()
  return process.env.DBZ_MYSQL_URL
}

export function conectar(url = urlDeConexion()) {
  if (!url) throw new Error('Falta DBZ_MYSQL_URL (o DBZ_MYSQL_URL_FILE)')
  const pool = mysql.createPool({
    uri: url,
    waitForConnections: true,
    connectionLimit: 10,
    // El servidor tiene 2 CPUs y varios back compartiendo el mismo MySQL: mejor
    // esperar que abrir conexiones sin límite.
    //
    // Pero esperar CON TECHO. `queueLimit: 0` es cola infinita: diez reemplazos de
    // colección tomaban las diez conexiones y todo lo que llegaba después se apilaba
    // para siempre, sin fallar nunca. Con techo, el pedido 71 se entera en el acto en
    // vez de quedar colgado, y eso es lo que el front necesita para reintentar.
    queueLimit: 60,
    // Un TCP que no completa no puede quedarse tomando un lugar de la cola.
    connectTimeout: 10000,
    // El MySQL corta las conexiones ociosas por su cuenta (wait_timeout). Sin esto, la
    // primera consulta después de un rato quieto sale por una conexión ya muerta.
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
    timezone: 'Z',
    charset: 'utf8mb4_unicode_ci',
  })

  /* Cada conexión dice en qué huso está, y no se da por sentado.

     El SQL de las estadísticas convierte de UTC a -03:00 (`aca()` en estadisticas.js) y
     la opción `timezone: 'Z'` de arriba NO alcanza: ésa sólo le dice a mysql2 cómo pasar
     un DATETIME a Date de JavaScript, no ejecuta ningún `SET time_zone`. O sea que todo
     dependía de con qué huso levantara el contenedor de MySQL.

     Si alguna vez se recreara con otro, las cuentas se correrían tres horas sin que nadie
     se entere, y las filas de `visita` —que las escribe el JS con hoyAca()— dejarían de
     alinearse con las que compara el SQL. El número de "cuántos vuelven", que es el que
     decide sobre la app, se habría inflado solo. */
  pool.on('connection', (conexion) => conexion.query("SET time_zone = '+00:00'"))

  return pool
}

/* Un pool aparte, de UNA conexión, sólo para el healthcheck.

   El healthcheck decide si el swarm mata la tarea, y no puede decidirlo con la cola que
   llenó el propio tráfico: diez reemplazos simultáneos dejaban a `/api/salud` esperando
   turno, el swarm daba la tarea por muerta y la reiniciaba — justo cuando más carga
   había, y dejando la app sin API en el peor momento. Con su conexión propia, la salud
   contesta lo que de verdad importa para esa decisión: si el proceso llega al MySQL.

   Una conexión de más sobre un pool de diez es barato al lado de un reinicio en falso. */
export function conectarSalud(url = urlDeConexion()) {
  return mysql.createPool({
    uri: url,
    waitForConnections: true,
    connectionLimit: 1,
    queueLimit: 4,
    connectTimeout: 5000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
    timezone: 'Z',
    charset: 'utf8mb4_unicode_ci',
  })
}

export async function prepararEsquema(pool) {
  for (const sql of TABLAS) await pool.query(sql)
  await ensancharUsuario(pool)
  await columnaApp(pool)
  await addMarkedAt(pool)
  await sembrarVisitas(pool)
}

/* `visita` nació sin la columna `app`, y CREATE TABLE IF NOT EXISTS no toca una tabla
   que ya existe. Igual que con el ancho de `usuario`: se agrega a mano, y sólo si
   falta. Cuenta si ese día entró desde la app instalada en el teléfono. */
async function columnaApp(pool) {
  const [filas] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'visita' AND COLUMN_NAME = 'app'`
  )
  if (!filas.length)
    await pool.query('ALTER TABLE visita ADD COLUMN app TINYINT UNSIGNED NOT NULL DEFAULT 0')
}

/* Cuándo se tocó cada carta por última vez.

   Hasta ahora `carta` no tenía ninguna fecha, así que **era imposible saber cuántas cartas
   se marcaron un día**. Lo único que había era `visita`, que dice «entró» pero no cuánto
   hizo: alguien que abre la app y no toca nada y alguien que carga doscientas cartas
   contaban exactamente igual. Es la métrica de actividad que más dice sobre si la app
   sirve, y no existía.

   Se agrega ahora aunque el panel todavía no la muestre, porque esto **sólo se llena
   hacia adelante**: cada día que pasa sin la columna es un día que no se recupera nunca.

   Dos decisiones del cómo:

   - `DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP` y no un valor que mande el
     código: el upsert de cada toque ya existe y no hay que tocarlo, así que esto no
     agrega ni una escritura al camino caliente. Una carta que se vuelve a guardar con el
     mismo número no cuenta como cambio y no mueve la fecha, que es lo correcto.
   - Las filas que YA existían quedan en `NULL`, no en la fecha de hoy. El `ALTER` las
     pondría a todas en este instante y el panel diría que las 7885 cartas se marcaron el
     día que se corrió la migración, que es mentira. `NULL` quiere decir «no sabemos», que
     es la verdad. Por eso el UPDATE de abajo, que corre UNA sola vez: una asignación
     explícita le gana al `ON UPDATE`, así que no se pisa sola. */
async function addMarkedAt(pool) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'carta' AND COLUMN_NAME = 'marked_at'`
  )
  if (rows.length) return
  await pool.query(
    `ALTER TABLE carta ADD COLUMN marked_at TIMESTAMP NULL
       DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`
  )
  await pool.query('UPDATE carta SET marked_at = NULL')
}

/* `visita` nació vacía, con la app andando hace una semana. Lo que ya se sabía de
   antes son dos cosas: el día que cada uno se anotó, y los días en que escribió la
   clave. No es todo lo que hizo, pero es mejor que empezar de cero.

   Sólo la primera vez: si la tabla tiene algo, esto no corre. */
async function sembrarVisitas(pool) {
  const [[{ hay }]] = await pool.query('SELECT COUNT(*) hay FROM visita')
  if (hay) return
  const aca = (col) => `DATE(CONVERT_TZ(${col}, '+00:00', '-03:00'))`
  await pool.query(`INSERT IGNORE INTO visita (usuario_id, dia)
                    SELECT id, ${aca('creado')} FROM usuario`)
  await pool.query(`INSERT IGNORE INTO visita (usuario_id, dia)
                    SELECT usuario_id, ${aca('creado')} FROM sesion`)
}

/* La columna nació de 32 y un mail entra justo o no entra. CREATE TABLE IF NOT EXISTS
   no toca una tabla que ya existe, así que hay que ensancharla a mano — sólo si hace
   falta, para no reconstruir la tabla en cada arranque. */
async function ensancharUsuario(pool) {
  const [filas] = await pool.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH largo FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuario' AND COLUMN_NAME = 'usuario'`
  )
  if (filas[0] && filas[0].largo < 64) {
    await pool.query('ALTER TABLE usuario MODIFY COLUMN usuario VARCHAR(64) NOT NULL')
  }
}

/* Las sesiones vencidas no se borran solas. Se limpia al arrancar y una vez por día. */
export async function borrarVencidas(pool) {
  const [r] = await pool.query('DELETE FROM sesion WHERE vence < NOW()')
  return r.affectedRows
}
