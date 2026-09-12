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
     usuario  VARCHAR(32)  NOT NULL,
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
  return mysql.createPool({
    uri: url,
    waitForConnections: true,
    connectionLimit: 10,
    // El servidor tiene 2 CPUs y varios back compartiendo el mismo MySQL: mejor
    // esperar que abrir conexiones sin límite.
    queueLimit: 0,
    timezone: 'Z',
    charset: 'utf8mb4_unicode_ci',
  })
}

export async function prepararEsquema(pool) {
  for (const sql of TABLAS) await pool.query(sql)
}

/* Las sesiones vencidas no se borran solas. Se limpia al arrancar y una vez por día. */
export async function borrarVencidas(pool) {
  const [r] = await pool.query('DELETE FROM sesion WHERE vence < NOW()')
  return r.affectedRows
}
