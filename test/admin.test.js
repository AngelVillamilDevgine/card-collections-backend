// Las estadísticas son sólo para el admin. Lo que más importa acá es que alguien que no
// lo es no pueda ver los mails ni los datos del resto.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { conectar, prepararEsquema } from '../src/base.js'

const URL = process.env.DBZ_MYSQL_URL_TEST ?? 'mysql://root:prueba@127.0.0.1:3307/dbz_prueba'
const ADMIN = 'jefe@ejemplo.com'
const OTRO = 'cualquiera@ejemplo.com'

let pool
let app

before(async () => {
  // Antes de importar el servidor: la lista de admins se lee al cargar el módulo.
  process.env.DBZ_ADMINS = ADMIN
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

beforeEach(async () => { await pool.query('DELETE FROM usuario') })

const registrar = async (usuario) => {
  const r = await app.inject({ method: 'POST', url: '/api/registro', payload: { usuario, clave: 'kamehameha' } })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().token
}
const auth = (t) => ({ authorization: `Bearer ${t}` })

test('el que no es admin no ve nada, y ni se entera de que existe', async () => {
  const token = await registrar(OTRO)
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(token) })
  assert.equal(r.statusCode, 404)
})

test('sin sesión tampoco', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen' })
  assert.equal(r.statusCode, 401)
})

test('/api/yo dice quién es admin y quién no', async () => {
  const jefe = await registrar(ADMIN)
  const otro = await registrar(OTRO)
  const a = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(jefe) })
  const b = await app.inject({ method: 'GET', url: '/api/yo', headers: auth(otro) })
  assert.equal(a.json().admin, true)
  assert.equal(b.json().admin, false)
})

test('el admin ve los números, y cuadran con lo que hay', async () => {
  const jefe = await registrar(ADMIN)
  const otro = await registrar(OTRO)
  // El admin marca dos cartas, una repetida; el otro no marca nada.
  for (const [clave, cantidad] of [['exp-1:1', 1], ['exp-1:2', 3]]) {
    await app.inject({ method: 'PUT', url: `/api/cartas/${clave}`, headers: auth(jefe), payload: { cantidad } })
  }
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(jefe) })
  assert.equal(r.statusCode, 200, r.body)
  const d = r.json()

  assert.equal(d.usuarios.total, 2, 'usuarios')
  assert.equal(d.usuarios.conCartas, 1, 'sólo uno marcó cartas')
  assert.equal(d.cartas.total, 2, 'dos cartas distintas')
  assert.equal(d.cartas.repetidas, 2, 'de una tiene 3, o sea 2 repetidas')
  assert.equal(d.gente.length, 2)

  const elJefe = d.gente.find((g) => g.usuario === ADMIN)
  assert.equal(elJefe.cartas, 2)
  assert.equal(elJefe.repetidas, 2)
  assert.equal(elJefe.dias, 1, 'entró un solo día')

  const elOtro = d.gente.find((g) => g.usuario === OTRO)
  assert.equal(elOtro.cartas, 0)
  // El que más tiene va primero: es la lista que se mira para decidir.
  assert.equal(d.gente[0].usuario, ADMIN)
})
