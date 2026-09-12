// Lo que se prueba acá no es que compile: es que la colección de uno no se filtre
// a la cuenta del otro.
//
// Necesita un MySQL de verdad, porque el SQL es la mitad de lo que hay que probar.
// Levantar uno descartable:
//   docker run -d --name dbz-mysql-prueba -e MYSQL_ROOT_PASSWORD=prueba \
//     -e MYSQL_DATABASE=dbz_prueba -p 3307:3306 mysql:8
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { conectar, prepararEsquema } from '../src/base.js'
import { crearApp } from '../src/servidor.js'

const URL = process.env.DBZ_MYSQL_URL_TEST
  ?? 'mysql://root:prueba@127.0.0.1:3307/dbz_prueba'

let pool
let app

before(async () => {
  pool = conectar(URL)
  await prepararEsquema(pool)
  app = crearApp(pool)
  await app.ready()
})

after(async () => {
  await app?.close()
  await pool?.end()
})

// Cada test arranca con la base vacía, o los contadores del anterior se le mezclan.
// Borrar usuario alcanza: carta y sesion caen por ON DELETE CASCADE.
beforeEach(async () => { await pool.query('DELETE FROM usuario') })

const pedir = (opciones) => app.inject(opciones)

async function registrar(usuario, clave = 'kamehameha') {
  const r = await pedir({ method: 'POST', url: '/api/registro', payload: { usuario, clave } })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().token
}

const auth = (token) => ({ authorization: `Bearer ${token}` })

test('registro devuelve un token y /yo lo reconoce', async () => {
  const token = await registrar('angel')
  const r = await pedir({ method: 'GET', url: '/api/yo', headers: auth(token) })
  assert.equal(r.json().usuario, 'angel')
})

test('no se puede registrar dos veces el mismo usuario', async () => {
  await registrar('angel')
  const r = await pedir({
    method: 'POST', url: '/api/registro', payload: { usuario: 'ANGEL', clave: 'kamehameha' },
  })
  // utf8mb4_unicode_ci no distingue mayusculas: Angel y angel son el mismo.
  assert.equal(r.statusCode, 409, r.body)
})

test('clave incorrecta no entra, y el mensaje no delata si el usuario existe', async () => {
  await registrar('angel')
  const mala = await pedir({
    method: 'POST', url: '/api/sesion', payload: { usuario: 'angel', clave: 'otracosa' },
  })
  const inexistente = await pedir({
    method: 'POST', url: '/api/sesion', payload: { usuario: 'goku', clave: 'otracosa' },
  })
  assert.equal(mala.statusCode, 401)
  assert.equal(inexistente.statusCode, 401)
  assert.deepEqual(mala.json(), inexistente.json())
})

test('entrar con la clave correcta devuelve un token que sirve', async () => {
  await registrar('angel')
  const r = await pedir({
    method: 'POST', url: '/api/sesion', payload: { usuario: 'angel', clave: 'kamehameha' },
  })
  assert.equal(r.statusCode, 200)
  const yo = await pedir({ method: 'GET', url: '/api/yo', headers: auth(r.json().token) })
  assert.equal(yo.json().usuario, 'angel')
})

test('sin token no se lee ni se escribe nada', async () => {
  for (const [method, url] of [['GET', '/api/coleccion'], ['PUT', '/api/cartas/exp-1:5']]) {
    const r = await pedir({ method, url, payload: { cantidad: 1 } })
    assert.equal(r.statusCode, 401, `${method} ${url}`)
  }
})

test('LA IMPORTANTE: la colección de uno no se le aparece al otro', async () => {
  const angel = await registrar('angel')
  const goku = await registrar('goku')

  await pedir({
    method: 'PUT', url: '/api/cartas/exp-1:5', headers: auth(angel),
    payload: { cantidad: 3, estado: 'perfecta' },
  })

  const suya = await pedir({ method: 'GET', url: '/api/coleccion', headers: auth(angel) })
  assert.deepEqual(suya.json(), { estados: { 'exp-1:5': 'perfecta' }, cantidades: { 'exp-1:5': 3 } })

  const ajena = await pedir({ method: 'GET', url: '/api/coleccion', headers: auth(goku) })
  assert.deepEqual(ajena.json(), { estados: {}, cantidades: {} })

  // Y si goku escribe la misma clave, no pisa la de angel: la primaria las separa.
  await pedir({
    method: 'PUT', url: '/api/cartas/exp-1:5', headers: auth(goku), payload: { cantidad: 1 },
  })
  const despues = await pedir({ method: 'GET', url: '/api/coleccion', headers: auth(angel) })
  assert.equal(despues.json().cantidades['exp-1:5'], 3)
})

test('cantidad 0 borra la carta y su condición', async () => {
  const token = await registrar('angel')
  const poner = (cuerpo) => pedir({
    method: 'PUT', url: '/api/cartas/exp-2:140', headers: auth(token), payload: cuerpo,
  })
  await poner({ cantidad: 2, estado: 'reemplazar' })
  await poner({ cantidad: 0, estado: 'reemplazar' })

  const r = await pedir({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.deepEqual(r.json(), { estados: {}, cantidades: {} })
})

test('no se guarda basura: claves raras, cantidades negativas, estados inventados', async () => {
  const token = await registrar('angel')
  const casos = [
    ['/api/cartas/..%2F..%2Fetc', { cantidad: 1 }],
    ['/api/cartas/exp-1:5', { cantidad: -3 }],
    ['/api/cartas/exp-1:5', { cantidad: 1.5 }],
    ['/api/cartas/exp-1:5', { cantidad: 1, estado: 'brillante' }],
  ]
  for (const [url, payload] of casos) {
    const r = await pedir({ method: 'PUT', url, headers: auth(token), payload })
    assert.equal(r.statusCode, 400, `${url} devolvió ${r.statusCode}`)
  }
})

test('cerrar sesión invalida el token', async () => {
  const token = await registrar('angel')
  await pedir({ method: 'DELETE', url: '/api/sesion', headers: auth(token) })
  const r = await pedir({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.equal(r.statusCode, 401)
})

test('borrar el usuario se lleva sus cartas y sus sesiones', async () => {
  const token = await registrar('angel')
  await pedir({
    method: 'PUT', url: '/api/cartas/exp-1:9', headers: auth(token), payload: { cantidad: 1 },
  })
  await pool.query('DELETE FROM usuario WHERE usuario = ?', ['angel'])

  const [cartas] = await pool.query('SELECT count(*) n FROM carta')
  const [sesiones] = await pool.query('SELECT count(*) n FROM sesion')
  assert.equal(cartas[0].n, 0, 'quedaron cartas huérfanas')
  assert.equal(sesiones[0].n, 0, 'quedaron sesiones huérfanas')
})

test('reemplazar la colección entera deja sólo lo nuevo', async () => {
  const token = await registrar('angel')
  await pedir({
    method: 'PUT', url: '/api/cartas/exp-1:1', headers: auth(token), payload: { cantidad: 9 },
  })
  const r = await pedir({
    method: 'PUT', url: '/api/coleccion', headers: auth(token),
    payload: { estados: { 'exp-3:300': 'bien' }, cantidades: { 'exp-3:300': 2 } },
  })
  assert.equal(r.json().cartas, 1)

  const final = await pedir({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.deepEqual(final.json().cantidades, { 'exp-3:300': 2 })
})

test('una colección entera de 1936 cartas entra sin romperse', async () => {
  const token = await registrar('angel')
  const cantidades = {}
  const estados = {}
  for (let n = 1; n <= 1936; n++) {
    cantidades[`exp-1:${n}`] = 1
    estados[`exp-1:${n}`] = 'bien'
  }
  const r = await pedir({
    method: 'PUT', url: '/api/coleccion', headers: auth(token), payload: { estados, cantidades },
  })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.json().cartas, 1936)

  const final = await pedir({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.equal(Object.keys(final.json().cantidades).length, 1936)
})

test('/api/salud contesta sin token, para el healthcheck del deploy', async () => {
  const r = await pedir({ method: 'GET', url: '/api/salud' })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().bien, true)
})

test('un mail sirve de usuario, y uno largo entra en la columna', async () => {
  const largo = 'angelvillamil1234@subdominio-bastante-largo.com.ar'
  const r = await pedir({
    method: 'POST', url: '/api/registro',
    payload: { usuario: largo, clave: 'kamehameha' },
  })
  assert.equal(r.statusCode, 200, r.body)

  const yo = await pedir({
    method: 'GET', url: '/api/yo', headers: auth(r.json().token),
  })
  // Si la columna quedó corta, MySQL lo trunca y el usuario deja de poder entrar.
  assert.equal(yo.json().usuario, largo)
})

test('sigue sin aceptar cualquier cosa de usuario', async () => {
  for (const malo of ['ab', 'con espacio', 'barra/adentro', 'a'.repeat(65)]) {
    const r = await pedir({
      method: 'POST', url: '/api/registro', payload: { usuario: malo, clave: 'kamehameha' },
    })
    assert.equal(r.statusCode, 400, `"${malo.slice(0, 20)}" devolvió ${r.statusCode}`)
  }
})
