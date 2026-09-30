// La clave provisoria: el ciclo entero, de punta a punta por HTTP.
//
// Lo que más importa: que la marca obligue a elegir una clave propia (viaja al entrar Y
// en /api/yo, así que recargar no la saltea), que elegirla la apague, que la clave vieja
// muera, y que resetear no toque las cartas ni las sesiones abiertas del dueño.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { conectar, prepararEsquema } from '../src/base.js'
import { resetPassword } from '../src/auth.js'
import { olvidarVisitas } from '../src/estadisticas.js'

const URL = process.env.DBZ_MYSQL_URL_TEST ?? 'mysql://root:prueba@127.0.0.1:3307/dbz_prueba'
const QUIEN = 'olvidadizo@ejemplo.com'

let pool
let app
let cliente = 0

before(async () => {
  const { crearApp } = await import('../src/servidor.js')
  pool = conectar(URL)
  await prepararEsquema(pool)
  app = crearApp(pool)
  await app.ready()
})

after(async () => {
  await app?.close()
  await pool?.end()
})

beforeEach(async () => {
  await pool.query('DELETE FROM usuario')
  olvidarVisitas()
})

/* Una IP por pedido: el freno a la fuerza bruta cuenta por IP y el `app` es uno solo. */
const ip = () => ({ 'cf-connecting-ip': `10.9.0.${++cliente}` })
const auth = (t) => ({ authorization: `Bearer ${t}` })
const registrar = async () => {
  const r = await app.inject({ method: 'POST', url: '/api/registro', payload: { usuario: QUIEN, clave: 'kamehameha' }, headers: ip() })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().token
}
const entrar = (clave) =>
  app.inject({ method: 'POST', url: '/api/sesion', payload: { usuario: QUIEN, clave }, headers: ip() })
const idDe = async () => (await pool.query('SELECT id FROM usuario WHERE usuario = ?', [QUIEN]))[0][0].id

test('la provisoria son ocho dígitos, y la clave vieja deja de andar', async () => {
  await registrar()
  const temporal = await resetPassword(pool, await idDe())
  assert.match(temporal, /^\d{8}$/)
  assert.equal((await entrar('kamehameha')).statusCode, 401)
  assert.equal((await entrar(temporal)).statusCode, 200)
})

test('entrar con la provisoria trae la marca, y /api/yo también', async () => {
  await registrar()
  const temporal = await resetPassword(pool, await idDe())
  const r = await entrar(temporal)
  assert.equal(r.json().mustChange, true)
  const yo = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(r.json().token) })
  assert.equal(yo.json().mustChange, true, 'recargar la página no puede saltear el cambio')
})

test('elegir una clave propia apaga la marca', async () => {
  await registrar()
  const temporal = await resetPassword(pool, await idDe())
  const token = (await entrar(temporal)).json().token
  const cambio = await app.inject({
    method: 'PUT', url: '/api/clave', headers: auth(token),
    payload: { actual: temporal, nueva: 'otraclave123' },
  })
  assert.equal(cambio.statusCode, 200, cambio.body)
  const yo = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(token) })
  assert.equal(yo.json().mustChange, false)
  const denuevo = await entrar('otraclave123')
  assert.equal(denuevo.json().mustChange, false)
})

test('una cuenta normal nunca trae la marca', async () => {
  const token = await registrar()
  assert.equal((await entrar('kamehameha')).json().mustChange, false)
  const yo = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(token) })
  assert.equal(yo.json().mustChange, false)
})

test('resetear no toca las cartas ni las sesiones abiertas', async () => {
  const token = await registrar()
  await app.inject({ method: 'PUT', url: '/api/cartas/exp-1:5', headers: auth(token), payload: { cantidad: 2, estado: 'perfecta' } })
  await resetPassword(pool, await idDe())
  /* La sesión de antes sigue viva — el dueño puede estar adentro en otro aparato — y sus
     cartas, intactas. Las otras sesiones se cierran cuando elija la clave nueva. */
  const c = await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.equal(c.statusCode, 200)
  assert.deepEqual(c.json().cantidades, { 'exp-1:5': 2 })
})
