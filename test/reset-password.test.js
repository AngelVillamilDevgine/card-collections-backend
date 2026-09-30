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
const USER = 'olvidadizo@ejemplo.com'

let pool
let app
let clientSeq = 0

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
const freshIp = () => ({ 'cf-connecting-ip': `10.9.0.${++clientSeq}` })
const auth = (t) => ({ authorization: `Bearer ${t}` })
const register = async () => {
  const r = await app.inject({ method: 'POST', url: '/api/registro', payload: { usuario: USER, clave: 'kamehameha' }, headers: freshIp() })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().token
}
const login = (clave) =>
  app.inject({ method: 'POST', url: '/api/sesion', payload: { usuario: USER, clave }, headers: freshIp() })
const userId = async () => (await pool.query('SELECT id FROM usuario WHERE usuario = ?', [USER]))[0][0].id

test('la provisoria son ocho dígitos, y la clave vieja deja de andar', async () => {
  await register()
  const temp = await resetPassword(pool, await userId())
  assert.match(temp, /^\d{8}$/)
  assert.equal((await login('kamehameha')).statusCode, 401)
  assert.equal((await login(temp)).statusCode, 200)
})

test('entrar con la provisoria trae la marca, y /api/yo también', async () => {
  await register()
  const temp = await resetPassword(pool, await userId())
  const r = await login(temp)
  assert.equal(r.json().mustChange, true)
  const me = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(r.json().token) })
  assert.equal(me.json().mustChange, true, 'recargar la página no puede saltear el cambio')
})

test('elegir una clave propia apaga la marca', async () => {
  await register()
  const temp = await resetPassword(pool, await userId())
  const token = (await login(temp)).json().token
  const change = await app.inject({
    method: 'PUT', url: '/api/clave', headers: auth(token),
    payload: { actual: temp, nueva: 'otraclave123' },
  })
  assert.equal(change.statusCode, 200, change.body)
  const me = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(token) })
  assert.equal(me.json().mustChange, false)
  const again = await login('otraclave123')
  assert.equal(again.json().mustChange, false)
})

test('una cuenta normal nunca trae la marca', async () => {
  const token = await register()
  assert.equal((await login('kamehameha')).json().mustChange, false)
  const me = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(token) })
  assert.equal(me.json().mustChange, false)
})

test('resetear no toca las cartas ni las sesiones abiertas', async () => {
  const token = await register()
  await app.inject({ method: 'PUT', url: '/api/cartas/exp-1:5', headers: auth(token), payload: { cantidad: 2, estado: 'perfecta' } })
  await resetPassword(pool, await userId())
  /* La sesión de antes sigue viva — el dueño puede estar adentro en otro aparato — y sus
     cartas, intactas. Las otras sesiones se cierran cuando elija la clave nueva. */
  const coll = await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.equal(coll.statusCode, 200)
  assert.deepEqual(coll.json().cantidades, { 'exp-1:5': 2 })
})
