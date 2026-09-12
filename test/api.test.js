// Lo que se prueba acá no es que compile: es que la colección de uno no se filtre
// a la cuenta del otro. Todo corre contra una base en memoria.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { abrir } from '../src/base.js'
import { crearApp } from '../src/servidor.js'

async function conApp() {
  const base = abrir(':memory:')
  const app = crearApp(base)
  await app.ready()
  return { app, base }
}

const pedir = (app, opciones) => app.inject(opciones)

async function registrar(app, usuario, clave = 'kamehameha') {
  const r = await pedir(app, { method: 'POST', url: '/api/registro', payload: { usuario, clave } })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().token
}

const auth = (token) => ({ authorization: `Bearer ${token}` })

test('registro devuelve un token y /yo lo reconoce', async () => {
  const { app } = await conApp()
  const token = await registrar(app, 'angel')
  const r = await pedir(app, { method: 'GET', url: '/api/yo', headers: auth(token) })
  assert.equal(r.json().usuario, 'angel')
})

test('no se puede registrar dos veces el mismo usuario', async () => {
  const { app } = await conApp()
  await registrar(app, 'angel')
  const r = await pedir(app, {
    method: 'POST', url: '/api/registro', payload: { usuario: 'ANGEL', clave: 'kamehameha' },
  })
  assert.equal(r.statusCode, 409) // COLLATE NOCASE: Angel y angel son el mismo
})

test('clave incorrecta no entra, y el mensaje no delata si el usuario existe', async () => {
  const { app } = await conApp()
  await registrar(app, 'angel')
  const mala = await pedir(app, {
    method: 'POST', url: '/api/sesion', payload: { usuario: 'angel', clave: 'otracosa' },
  })
  const inexistente = await pedir(app, {
    method: 'POST', url: '/api/sesion', payload: { usuario: 'goku', clave: 'otracosa' },
  })
  assert.equal(mala.statusCode, 401)
  assert.equal(inexistente.statusCode, 401)
  assert.deepEqual(mala.json(), inexistente.json())
})

test('sin token no se lee ni se escribe nada', async () => {
  const { app } = await conApp()
  for (const [method, url] of [['GET', '/api/coleccion'], ['PUT', '/api/cartas/exp-1:5']]) {
    const r = await pedir(app, { method, url, payload: { cantidad: 1 } })
    assert.equal(r.statusCode, 401, `${method} ${url}`)
  }
})

test('LA IMPORTANTE: la colección de uno no se le aparece al otro', async () => {
  const { app } = await conApp()
  const angel = await registrar(app, 'angel')
  const goku = await registrar(app, 'goku')

  await pedir(app, {
    method: 'PUT', url: '/api/cartas/exp-1:5', headers: auth(angel),
    payload: { cantidad: 3, estado: 'perfecta' },
  })

  const suya = await pedir(app, { method: 'GET', url: '/api/coleccion', headers: auth(angel) })
  assert.deepEqual(suya.json(), { estados: { 'exp-1:5': 'perfecta' }, cantidades: { 'exp-1:5': 3 } })

  const ajena = await pedir(app, { method: 'GET', url: '/api/coleccion', headers: auth(goku) })
  assert.deepEqual(ajena.json(), { estados: {}, cantidades: {} })

  // Y si goku escribe la misma clave, no pisa la de angel: la primaria las separa.
  await pedir(app, {
    method: 'PUT', url: '/api/cartas/exp-1:5', headers: auth(goku), payload: { cantidad: 1 },
  })
  const despues = await pedir(app, { method: 'GET', url: '/api/coleccion', headers: auth(angel) })
  assert.equal(despues.json().cantidades['exp-1:5'], 3)
})

test('cantidad 0 borra la carta y su condición', async () => {
  const { app } = await conApp()
  const token = await registrar(app, 'angel')
  const poner = (cuerpo) => pedir(app, {
    method: 'PUT', url: '/api/cartas/exp-2:140', headers: auth(token), payload: cuerpo,
  })
  await poner({ cantidad: 2, estado: 'reemplazar' })
  await poner({ cantidad: 0, estado: 'reemplazar' })

  const r = await pedir(app, { method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.deepEqual(r.json(), { estados: {}, cantidades: {} })
})

test('no se guarda basura: claves raras, cantidades negativas, estados inventados', async () => {
  const { app } = await conApp()
  const token = await registrar(app, 'angel')
  const casos = [
    ['/api/cartas/..%2F..%2Fetc', { cantidad: 1 }],
    ['/api/cartas/exp-1:5', { cantidad: -3 }],
    ['/api/cartas/exp-1:5', { cantidad: 1.5 }],
    ['/api/cartas/exp-1:5', { cantidad: 1, estado: 'brillante' }],
  ]
  for (const [url, payload] of casos) {
    const r = await pedir(app, { method: 'PUT', url, headers: auth(token), payload })
    assert.equal(r.statusCode, 400, `${url} ${JSON.stringify(payload)} devolvió ${r.statusCode}`)
  }
})

test('cerrar sesión invalida el token', async () => {
  const { app } = await conApp()
  const token = await registrar(app, 'angel')
  await pedir(app, { method: 'DELETE', url: '/api/sesion', headers: auth(token) })
  const r = await pedir(app, { method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.equal(r.statusCode, 401)
})

test('reemplazar la colección entera deja sólo lo nuevo', async () => {
  const { app } = await conApp()
  const token = await registrar(app, 'angel')
  await pedir(app, {
    method: 'PUT', url: '/api/cartas/exp-1:1', headers: auth(token), payload: { cantidad: 9 },
  })
  const r = await pedir(app, {
    method: 'PUT', url: '/api/coleccion', headers: auth(token),
    payload: { estados: { 'exp-3:300': 'bien' }, cantidades: { 'exp-3:300': 2 } },
  })
  assert.equal(r.json().cartas, 1)

  const final = await pedir(app, { method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.deepEqual(final.json().cantidades, { 'exp-3:300': 2 })
})

test('/api/salud contesta sin token, para el healthcheck del deploy', async () => {
  const { app } = await conApp()
  const r = await pedir(app, { method: 'GET', url: '/api/salud' })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().bien, true)
})
