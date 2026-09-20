// Registro, login y sesiones. Sin librerías de criptografía: todo lo que hace falta
// está en node:crypto.
//
// La clave se guarda con scrypt (lento a propósito, para que probar claves una por una
// no sea gratis). La sesión es un token opaco al azar, no un JWT: se puede revocar
// borrando una fila, y no hay nada que firmar ni que caducar del lado del navegador.
import crypto from 'node:crypto'

// Cuánto dura una sesión. No hay renovación: vencido el plazo, hay que entrar de nuevo.
const DIAS = 30
const LARGO_CLAVE = 8
const SCRYPT = { N: 16384, r: 8, p: 1 }

function scrypt(clave, sal) {
  return new Promise((listo, falla) => {
    crypto.scrypt(clave, sal, 32, SCRYPT, (e, salida) =>
      e ? falla(e) : listo(salida.toString('hex')))
  })
}

export async function hashearClave(clave) {
  const sal = crypto.randomBytes(16).toString('hex')
  return `${sal}:${await scrypt(clave, sal)}`
}

export async function claveCoincide(clave, guardado) {
  const [sal, esperado] = String(guardado).split(':')
  if (!sal || !esperado) return false
  const calculado = await scrypt(clave, sal)
  // Comparar con === filtraría la clave por el tiempo que tarda en fallar.
  const a = Buffer.from(calculado, 'hex')
  const b = Buffer.from(esperado, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/* Un hash de descarte contra el que comparar cuando el usuario NO existe, para que
   negarle cueste lo mismo que negarle a uno real.

   Sin esto, al inexistente se le contesta al instante y al real recién después del
   scrypt: midiendo el tiempo de respuesta se averigua quién tiene cuenta — que es
   exactamente lo que el mensaje único ("usuario o clave incorrectos") quiere evitar.

   Se calcula una sola vez, al primer uso. La clave de la que sale es al azar y se tira:
   a nadie le sirve para nada. */
let fantasma
export async function gastarComoSiExistiera(clave) {
  fantasma ??= await hashearClave(crypto.randomBytes(18).toString('hex'))
  await claveCoincide(typeof clave === 'string' ? clave : '', fantasma)
}

export const hashDeToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex')

export async function crearSesion(pool, usuarioId) {
  const token = crypto.randomBytes(32).toString('base64url')
  await pool.query(
    'INSERT INTO sesion (hash, usuario_id, vence) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))',
    [hashDeToken(token), usuarioId, DIAS]
  )
  return token
}

export async function cerrarSesion(pool, token) {
  const [r] = await pool.query('DELETE FROM sesion WHERE hash = ?', [hashDeToken(token)])
  return r.affectedRows
}

export async function usuarioDeToken(pool, token) {
  if (!token) return null
  const [filas] = await pool.query(
    `SELECT u.id, u.usuario
       FROM sesion s JOIN usuario u ON u.id = s.usuario_id
      WHERE s.hash = ? AND s.vence > NOW()`,
    [hashDeToken(token)]
  )
  return filas[0] ?? null
}

/* Qué se acepta como nombre y como clave. Los mensajes van al usuario, en castellano. */
/* Para crear una cuenta pedimos un mail. No se le manda nada: la app no manda mails.
   Es para que cada uno sepa con qué entró y no queden tres cuentas parecidas del mismo.

   OJO: esto se usa SÓLO al registrarse. Al entrar no se valida el formato, porque hay
   cuentas viejas con nombre a secas y dejarían de poder entrar. */
const MAIL = /^[^\s@]{1,64}@[^\s@]{1,63}\.[a-zA-Z]{2,}$/

export function revisarCredenciales(usuario, clave) {
  if (typeof usuario !== 'string' || typeof clave !== 'string')
    return 'Faltan el mail o la clave.'
  // 64 es lo que entra en la columna.
  if (usuario.length > 64) return 'Ese mail es demasiado largo.'
  if (!MAIL.test(usuario))
    return 'Para crear tu cuenta hace falta un mail.'
  if (clave.length < LARGO_CLAVE)
    return `La clave necesita al menos ${LARGO_CLAVE} caracteres.`
  return null
}

export function tokenDe(pedido) {
  const cabecera = pedido.headers.authorization ?? ''
  return cabecera.startsWith('Bearer ') ? cabecera.slice(7) : null
}
