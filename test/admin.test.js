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

/* Una IP por registro: el freno a la fuerza bruta es por IP y el balde vive en el
   `app`, que es uno solo para todo el archivo. Ahora que el registro también frena, sin
   esto los tests se comerían el balde entre ellos. */
let cliente = 0

const registrar = async (usuario) => {
  const r = await app.inject({
    method: 'POST', url: '/api/registro', payload: { usuario, clave: 'kamehameha' },
    headers: { 'cf-connecting-ip': `10.1.0.${++cliente}` },
  })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().token
}
const auth = (t) => ({ authorization: `Bearer ${t}` })

test('el que no es admin no ve nada, y ni se entera de que existe', async () => {
  const token = await registrar(OTRO)
  const r = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(token) })
  assert.equal(r.statusCode, 404)
})

/* Esto es lo que hace que el panel sirva para decidir algo: si "volvieron otro día"
   se midiera con las sesiones, el que entra una vez y usa la app todos los días
   contaría como que no volvió, porque la sesión dura 30 días. */
test('usar la app anota el día, aunque no se entre de nuevo', async () => {
  const token = await registrar(OTRO)
  await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(token) })

  // La visita se anota sin esperarla, así que se le da un momento.
  let filas = []
  for (let i = 0; i < 40 && !filas.length; i++) {
    ;[filas] = await pool.query('SELECT dia FROM visita')
    if (!filas.length) await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(filas.length, 1, 'tendría que haber un día anotado, y uno solo')

  // Y mil pedidos más del mismo día no agregan filas.
  for (let i = 0; i < 5; i++)
    await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  const [despues] = await pool.query('SELECT COUNT(*) n FROM visita')
  assert.equal(Number(despues[0].n), 1)
})

/* Saber cuántos la instalaron es lo que va a decir si el aviso sirvió. Y una vez que
   el día quedó marcado como app, entrar por el navegador no lo tiene que borrar. */
test('entrar como app queda anotado, y el navegador no lo pisa', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/registro?app=1', payload: { usuario: OTRO, clave: 'kamehameha' },
    headers: { 'cf-connecting-ip': `10.1.0.${++cliente}` },
  })
  assert.equal(r.statusCode, 200, r.body)
  const token = r.json().token

  let filas = []
  for (let i = 0; i < 40 && !filas.length; i++) {
    ;[filas] = await pool.query('SELECT app FROM visita')
    if (!filas.length) await new Promise((r2) => setTimeout(r2, 25))
  }
  assert.equal(Number(filas[0].app), 1, 'el día tendría que haber quedado marcado como app')

  await app.inject({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  await new Promise((r2) => setTimeout(r2, 150))
  const [despues] = await pool.query('SELECT app, COUNT(*) n FROM visita GROUP BY app')
  assert.equal(despues.length, 1)
  assert.equal(Number(despues[0].app), 1, 'un pedido desde el navegador no puede desmarcarlo')
  assert.equal(Number(despues[0].n), 1)

  const resumen = await app.inject({ method: 'GET', url: '/api/admin/resumen', headers: auth(await registrar(ADMIN)) })
  assert.equal(resumen.json().usuarios.conApp, 1)
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
