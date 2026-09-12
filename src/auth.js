// Registro, login y sesiones. Sin librerías de criptografía: todo lo que hace falta
// está en node:crypto.
//
// La clave se guarda con scrypt (lento a propósito, para que probar claves una por una
// no sea gratis). La sesión es un token opaco al azar, no un JWT: se puede revocar
// borrando una fila, y no hay nada que firmar ni que caducar del lado del navegador.
import crypto from 'node:crypto'

const DIAS = 90
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
export function revisarCredenciales(usuario, clave) {
  if (typeof usuario !== 'string' || typeof clave !== 'string')
    return 'Faltan el usuario o la clave.'
  // Se aceptan @ y + porque mucha gente pone su mail de usuario. No se valida que
  // sea un mail de verdad: acá es un nombre para entrar, no una dirección a la que
  // se le mande nada.
  if (!/^[a-zA-Z0-9._@+-]{3,64}$/.test(usuario))
    return 'El usuario va de 3 a 64 caracteres: letras, números, punto, guión, guión bajo, arroba o más.'
  if (clave.length < LARGO_CLAVE)
    return `La clave necesita al menos ${LARGO_CLAVE} caracteres.`
  return null
}

export function tokenDe(pedido) {
  const cabecera = pedido.headers.authorization ?? ''
  return cabecera.startsWith('Bearer ') ? cabecera.slice(7) : null
}
