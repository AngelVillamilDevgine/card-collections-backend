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
    queueLimit: 0,
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

export async function prepararEsquema(pool) {
  for (const sql of TABLAS) await pool.query(sql)
  await ensancharUsuario(pool)
  await columnaApp(pool)
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
