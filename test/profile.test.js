// «Mi perfil» y la clave provisoria desde el panel.
//
// Lo que más importa: que nadie pueda leer ni escribir el perfil de otro (el id sale del
// token), que la validación frene lo que no es un dato, y que el botón del panel sea SÓLO
// del admin — a cualquier otro, 404, igual que el resumen.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { conectar, prepararEsquema } from '../src/base.js'
import { validateProfile } from '../src/profile.js'
import { olvidarVisitas, resumen } from '../src/estadisticas.js'

const URL = process.env.DBZ_MYSQL_URL_TEST ?? 'mysql://root:prueba@127.0.0.1:3307/dbz_prueba'
const ADMIN = 'boss@ejemplo.com'
const ANA = 'ana@ejemplo.com'
const BETO = 'beto@ejemplo.com'

let pool
let app
let clientSeq = 0

before(async () => {
  process.env.DBZ_ADMINS = ADMIN // antes de importar el servidor: se lee al cargarlo
  const { crearApp } = await import('../src/servidor.js')
  pool = conectar(URL)
  await prepararEsquema(pool)
  app = crearApp(pool)
  await app.ready()
})

after(async () => {
  delete process.env.DBZ_ADMINS
  await app?.close()
  await pool?.end()
})

beforeEach(async () => {
  await pool.query('DELETE FROM usuario')
  olvidarVisitas()
})

const freshIp = () => ({ 'cf-connecting-ip': `10.8.0.${++clientSeq}` })
const auth = (t) => ({ authorization: `Bearer ${t}` })
const register = async (user) => {
  const r = await app.inject({ method: 'POST', url: '/api/registro', payload: { usuario: user, clave: 'kamehameha' }, headers: freshIp() })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().token
}
const FULL = { firstName: 'Gabriel', middleName: 'Omar', lastName: 'Rivarola', whatsapp: '+54 9 351 671-0050', city: 'Córdoba' }

// ------------------------------------------------------------ la validación

test('todo vacío es un perfil válido: nada es obligatorio', () => {
  const { data, error } = validateProfile({})
  assert.equal(error, undefined)
  assert.deepEqual(data, { first_name: null, middle_name: null, last_name: null, whatsapp: null, city: null })
})

test('recorta, junta espacios repetidos, y un campo en blanco es NULL', () => {
  const { data } = validateProfile({ firstName: '  Juan   Pablo ', city: '   ' })
  assert.equal(data.first_name, 'Juan Pablo')
  assert.equal(data.city, null)
})

test('frena lo que no es un dato', () => {
  assert.match(validateProfile({ firstName: 'x'.repeat(61) }).error, /hasta 60/)
  assert.match(validateProfile({ lastName: 42 }).error, /texto/)
  assert.match(validateProfile({ city: 'Córdoba\u0000' }).error, /caracteres/)
  assert.match(validateProfile(null).error, /Faltan/)
  assert.match(validateProfile([]).error, /Faltan/)
})

test('el WhatsApp es un número, escrito como lo escribe la gente', () => {
  assert.equal(validateProfile({ whatsapp: '+54 9 351 671-0050' }).error, undefined)
  assert.equal(validateProfile({ whatsapp: '(0351) 15-6710050' }).error, undefined)
  assert.match(validateProfile({ whatsapp: 'mi cel' }).error, /número/)
  assert.match(validateProfile({ whatsapp: '123' }).error, /incompleto/)
})

// ------------------------------------------------------------ por HTTP

test('un perfil nuevo viene vacío, con el mail de la cuenta', async () => {
  const token = await register(ANA)
  const r = await app.inject({ method: 'GET', url: '/api/profile', headers: auth(token) })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(r.json(), { usuario: ANA, firstName: '', middleName: '', lastName: '', whatsapp: '', city: '' })
})

test('guardar y volver a leer', async () => {
  const token = await register(ANA)
  const put = await app.inject({ method: 'PUT', url: '/api/profile', headers: auth(token), payload: FULL })
  assert.equal(put.statusCode, 200, put.body)
  assert.deepEqual(put.json(), { usuario: ANA, ...FULL })
  const get = await app.inject({ method: 'GET', url: '/api/profile', headers: auth(token) })
  assert.deepEqual(get.json(), { usuario: ANA, ...FULL })
})

test('un dato inválido no guarda NADA, ni los campos buenos', async () => {
  const token = await register(ANA)
  const r = await app.inject({ method: 'PUT', url: '/api/profile', headers: auth(token), payload: { ...FULL, whatsapp: 'no tengo' } })
  assert.equal(r.statusCode, 400)
  const get = await app.inject({ method: 'GET', url: '/api/profile', headers: auth(token) })
  assert.equal(get.json().firstName, '')
})

test('LA IMPORTANTE: el perfil de uno no toca ni muestra el de otro', async () => {
  const ana = await register(ANA)
  const beto = await register(BETO)
  await app.inject({ method: 'PUT', url: '/api/profile', headers: auth(ana), payload: FULL })
  const betoReads = await app.inject({ method: 'GET', url: '/api/profile', headers: auth(beto) })
  assert.deepEqual(betoReads.json(), { usuario: BETO, firstName: '', middleName: '', lastName: '', whatsapp: '', city: '' })
  /* Y aunque el cuerpo traiga un `usuario` ajeno, se escribe el del token. */
  await app.inject({ method: 'PUT', url: '/api/profile', headers: auth(beto), payload: { ...FULL, firstName: 'Beto', usuario: ANA } })
  const anaReads = await app.inject({ method: 'GET', url: '/api/profile', headers: auth(ana) })
  assert.equal(anaReads.json().firstName, 'Gabriel')
})

test('sin sesión no hay perfil', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/profile' })
  assert.equal(r.statusCode, 401)
})

// ------------------------------------------------------------ el botón del panel

test('la clave provisoria desde el panel es SÓLO del admin: a otro, 404', async () => {
  await register(ANA)
  const beto = await register(BETO)
  const r = await app.inject({ method: 'POST', url: '/api/admin/reset-password', headers: auth(beto), payload: { usuario: ANA } })
  assert.equal(r.statusCode, 404)
  /* Y la clave de Ana sigue andando: el pedido no tocó nada. */
  const login = await app.inject({ method: 'POST', url: '/api/sesion', payload: { usuario: ANA, clave: 'kamehameha' }, headers: freshIp() })
  assert.equal(login.statusCode, 200)
})

test('a otro, el 404 es IDÉNTICO al de una dirección que no existe', async () => {
  const beto = await register(BETO)
  const reset = await app.inject({ method: 'POST', url: '/api/admin/reset-password', headers: auth(beto), payload: { usuario: ANA } })
  const nowhere = await app.inject({ method: 'POST', url: '/api/admin/nothing-here', headers: auth(beto), payload: {} })
  assert.equal(reset.statusCode, 404)
  assert.equal(reset.body, nowhere.body)
})

test('la cuenta de un admin NO se resetea desde el panel: un token robado no se lleva otra cuenta de admin', async () => {
  const boss = await register(ADMIN)
  const r = await app.inject({ method: 'POST', url: '/api/admin/reset-password', headers: auth(boss), payload: { usuario: ADMIN } })
  assert.equal(r.statusCode, 400)
  assert.match(r.json().error, /reset-password.js/)
  const login = await app.inject({ method: 'POST', url: '/api/sesion', payload: { usuario: ADMIN, clave: 'kamehameha' }, headers: freshIp() })
  assert.equal(login.statusCode, 200)
})

test('el admin genera la provisoria: la vieja muere y la nueva obliga a cambiarla', async () => {
  await register(ANA)
  const boss = await register(ADMIN)
  const r = await app.inject({ method: 'POST', url: '/api/admin/reset-password', headers: auth(boss), payload: { usuario: ANA } })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.json().usuario, ANA)
  assert.match(r.json().temp, /^\d{8}$/)
  const oldLogin = await app.inject({ method: 'POST', url: '/api/sesion', payload: { usuario: ANA, clave: 'kamehameha' }, headers: freshIp() })
  assert.equal(oldLogin.statusCode, 401)
  const newLogin = await app.inject({ method: 'POST', url: '/api/sesion', payload: { usuario: ANA, clave: r.json().temp }, headers: freshIp() })
  assert.equal(newLogin.json().mustChange, true)
})

test('una cuenta que no existe, o que no viene, no rompe nada', async () => {
  const boss = await register(ADMIN)
  const missing = await app.inject({ method: 'POST', url: '/api/admin/reset-password', headers: auth(boss), payload: { usuario: 'nadie@ejemplo.com' } })
  assert.equal(missing.statusCode, 404)
  const empty = await app.inject({ method: 'POST', url: '/api/admin/reset-password', headers: auth(boss), payload: {} })
  assert.equal(empty.statusCode, 400)
})

test('la lista del panel trae el perfil y la marca de provisoria de cada uno', async () => {
  const ana = await register(ANA)
  await app.inject({ method: 'PUT', url: '/api/profile', headers: auth(ana), payload: FULL })
  const d = await resumen(pool)
  const row = d.gente.find((g) => g.usuario === ANA)
  assert.deepEqual(row.profile, FULL)
  assert.equal(row.mustChange, false)
})
