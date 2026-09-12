// La API está publicada en un puerto propio del VPS, así que lo primero que la toca
// es cualquiera que escanee el puerto. Esto verifica que sin la cabecera no se pasa.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { conectar, prepararEsquema } from '../src/base.js'

const URL = process.env.DBZ_MYSQL_URL_TEST
  ?? 'mysql://root:prueba@127.0.0.1:3307/dbz_prueba'

const SECRETO = 'un-secreto-de-prueba'

let pool
let app

before(async () => {
  // Se pone antes de importar el servidor: el secreto se lee al crear la app.
  process.env.DBZ_SECRETO_PROXY = SECRETO
  const { crearApp } = await import('../src/servidor.js')
  pool = conectar(URL)
  await prepararEsquema(pool)
  await pool.query('DELETE FROM usuario')
  app = crearApp(pool)
  await app.ready()
})

after(async () => {
  delete process.env.DBZ_SECRETO_PROXY
  await app?.close()
  await pool?.end()
})

test('sin la cabecera, la API dice que no existe', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/registro',
    payload: { usuario: 'colado', clave: 'kamehameha' },
  })
  // 404 y no 401 a propósito: a un escáner no se le confirma que acá hay algo.
  assert.equal(r.statusCode, 404)
})

test('con la cabecera equivocada tampoco', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/registro',
    headers: { 'x-dbz-proxy': 'otra-cosa' },
    payload: { usuario: 'colado', clave: 'kamehameha' },
  })
  assert.equal(r.statusCode, 404)
})

test('con la cabecera correcta, funciona normal', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/registro',
    headers: { 'x-dbz-proxy': SECRETO },
    payload: { usuario: 'conlallave', clave: 'kamehameha' },
  })
  assert.equal(r.statusCode, 200, r.body)
  assert.ok(r.json().token)
})

test('/api/salud contesta sin cabecera: lo consulta el healthcheck', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/salud' })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().bien, true)
})
