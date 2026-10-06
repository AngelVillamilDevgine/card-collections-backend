// Registro, login y sesiones. Sin librerías de criptografía: todo lo que hace falta
// está en node:crypto.
//
// La clave se guarda con scrypt (lento a propósito, para que probar claves una por una
// no sea gratis). La sesión es un token opaco al azar, no un JWT: se puede revocar
// borrando una fila, y no hay nada que firmar ni que caducar del lado del navegador.
import crypto from 'node:crypto'

// Cuánto dura una sesión. No hay renovación: vencido el plazo, hay que entrar de nuevo.
const SESSION_DAYS = 30
const MIN_PASSWORD_LENGTH = 8
const SCRYPT = { N: 16384, r: 8, p: 1 }

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, SCRYPT, (e, derivedKey) =>
      e ? reject(e) : resolve(derivedKey.toString('hex')))
  })
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  return `${salt}:${await scrypt(password, salt)}`
}

export async function verifyPassword(password, storedHash) {
  const [salt, expectedHash] = String(storedHash).split(':')
  if (!salt || !expectedHash) return false
  const computedHash = await scrypt(password, salt)
  // Comparar con === filtraría la clave por el tiempo que tarda en fallar.
  const a = Buffer.from(computedHash, 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/* Un hash de descarte contra el que comparar cuando el usuario NO existe, para que
   negarle cueste lo mismo que negarle a uno real.

   Sin esto, al inexistente se le contesta al instante y al real recién después del
   scrypt: midiendo el tiempo de respuesta se averigua quién tiene cuenta — que es
   exactamente lo que el mensaje único ("usuario o clave incorrectos") quiere evitar.

   Se calcula una sola vez, al primer uso. La clave de la que sale es al azar y se tira:
   a nadie le sirve para nada. */
let dummyHash
export async function simulatePasswordCheck(password) {
  dummyHash ??= await hashPassword(crypto.randomBytes(18).toString('hex'))
  await verifyPassword(typeof password === 'string' ? password : '', dummyHash)
}

export const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex')

export async function createSession(pool, userId) {
  const token = crypto.randomBytes(32).toString('base64url')
  await pool.query(
    'INSERT INTO sesion (hash, usuario_id, vence) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))',
    [hashToken(token), userId, SESSION_DAYS]
  )
  return token
}

export async function revokeSession(pool, token) {
  const [r] = await pool.query('DELETE FROM sesion WHERE hash = ?', [hashToken(token)])
  return r.affectedRows
}

/* Echar a todas las demás sesiones de esta cuenta, menos la que está pidiendo.

   Es la mitad que importa del cambio de clave: cambiarla y dejar vivas las sesiones que
   ya estaban abiertas no echa a nadie. El token es opaco y dura 30 días, así que quien
   se lo llevó seguiría entrando un mes entero aunque el dueño cambie la clave todos los
   días. Se borra la fila y listo: no hay nada que caducar del lado del navegador, que es
   justamente por qué esto no son JWT. */
export async function revokeOtherSessions(pool, userId, currentToken) {
  const [r] = await pool.query(
    'DELETE FROM sesion WHERE usuario_id = ? AND hash <> ?',
    [userId, hashToken(currentToken)]
  )
  return r.affectedRows
}

/* Cambiar la clave. Devuelve false si la actual no coincide — y paga el scrypt igual,
   porque acá el usuario ya está identificado por el token y no hay nada que filtrar,
   pero el tiempo constante no cuesta nada y evita pensarlo de nuevo mañana. */
export async function changePassword(pool, userId, currentPassword, newPassword) {
  const [rows] = await pool.query('SELECT hash FROM usuario WHERE id = ?', [userId])
  if (!rows.length) return false
  if (!(await verifyPassword(currentPassword, rows[0].hash))) return false
  // Elegir una clave propia apaga la marca de la provisoria: es lo que la app espera.
  await pool.query('UPDATE usuario SET hash = ?, must_change = 0 WHERE id = ?', [await hashPassword(newPassword), userId])
  return true
}

/* LA CLAVE PROVISORIA para quien se olvidó la suya. Ocho dígitos AL AZAR y no un
   `12345678`: se dicta igual de fácil por WhatsApp, pero una clave fija es lo primero que
   alguien prueba contra una cuenta mientras el dueño todavía no entró. `randomInt` es de
   `crypto`, no `Math.random`. Prende `must_change`: la app no deja hacer nada hasta elegir
   una propia. Las sesiones abiertas NO se tocan acá — el dueño puede seguir adentro en
   otro aparato —: se cierran solas cuando elija la nueva, que es lo que ya hace
   `/api/clave`. Devuelve la provisoria para dársela a la persona. */
export async function resetPassword(pool, userId) {
  const temp = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0')
  await pool.query(
    'UPDATE usuario SET hash = ?, must_change = 1 WHERE id = ?',
    [await hashPassword(temp), userId]
  )
  return temp
}

export async function findUserByToken(pool, token) {
  if (!token) return null
  const [rows] = await pool.query(
    `SELECT u.id, u.usuario, u.must_change
       FROM sesion s JOIN usuario u ON u.id = s.usuario_id
      WHERE s.hash = ? AND s.vence > NOW()`,
    [hashToken(token)]
  )
  return rows[0] ?? null
}

/* Qué se acepta como nombre y como clave. Los mensajes van al usuario, en castellano. */
/* Para crear una cuenta pedimos un mail. No se le manda nada: la app no manda mails.
   Es para que cada uno sepa con qué entró y no queden tres cuentas parecidas del mismo.

   OJO: esto se usa SÓLO al registrarse. Al entrar no se valida el formato, porque hay
   cuentas viejas con nombre a secas y dejarían de poder entrar. */
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,63}\.[a-zA-Z]{2,}$/

/* LA CLAVE SOLA, y hace falta aparte.
 *
 * «Cambiar mi clave» llamaba a `validateSignupCredentials` con el usuario de la cuenta, o sea que
 * le pasaba por `EMAIL_PATTERN` un nombre QUE YA EXISTE. Y hay cuentas viejas con nombre a secas
 * —el propio comentario de arriba lo dice, y `Login.jsx` también—, así que a ésas les
 * contestaba «Para crear tu cuenta hace falta un mail» en una pantalla donde no se está
 * creando ninguna cuenta, con un 400, y NO PODÍAN CAMBIAR LA CLAVE NUNCA. Justo las más
 * viejas, que son las que más razones tienen para rotarla, y el único camino que hay para
 * echar una sesión ajena.
 *
 * El comentario de arriba decía «esto se usa SÓLO al registrarse» y hacía rato que no. */
const MAX_PASSWORD_LENGTH = 200

export function validatePassword(password) {
  if (typeof password !== 'string') return 'Falta la clave.'
  if (password.length < MIN_PASSWORD_LENGTH)
    return `La clave necesita al menos ${MIN_PASSWORD_LENGTH} caracteres.`
  /* Un techo, que no había. No es por el scrypt —su costo lo fijan N, r y p, no el largo
     de la entrada— sino porque una clave de un megabyte no es una clave, y sin techo cada
     intento arrastra ese megabyte por el threadpool. No echa a nadie: al ENTRAR no se
     valida el largo, así que una clave vieja más larga que esto sigue andando. */
  if (password.length > MAX_PASSWORD_LENGTH)
    return `La clave no puede pasar de ${MAX_PASSWORD_LENGTH} caracteres.`
  return null
}

export function validateSignupCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string')
    return 'Faltan el mail o la clave.'
  // 64 es lo que entra en la columna.
  if (username.length > 64) return 'Ese mail es demasiado largo.'
  if (!EMAIL_PATTERN.test(username))
    return 'Para crear tu cuenta hace falta un mail.'
  /* La misma regla y no una copia: si acá se pidieran ocho y allá nueve, cambiar la clave
     se volvería imposible sin que nada avise. */
  return validatePassword(password)
}

export function getBearerToken(request) {
  const authHeader = request.headers.authorization ?? ''
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
}
