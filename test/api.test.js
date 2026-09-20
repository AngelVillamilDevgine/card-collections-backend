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

/* Cada pedido de los tests sale con su propia IP, salvo que el test diga otra cosa: el
   freno a la fuerza bruta es por IP y el balde vive en el `app`, que es uno solo para
   todo el archivo. Sin esto los tests se comen el balde entre ellos —ahora que el
   registro también frena— y los últimos empiezan a recibir 429 por culpa de los
   primeros. */
let cliente = 0
const pedir = (opciones) =>
  app.inject({
    ...opciones,
    headers: { 'cf-connecting-ip': `10.0.${(++cliente / 250) | 0}.${cliente % 250}`, ...opciones.headers },
  })

async function registrar(usuario, clave = 'kamehameha') {
  const r = await pedir({ method: 'POST', url: '/api/registro', payload: { usuario, clave } })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().token
}

const auth = (token) => ({ authorization: `Bearer ${token}` })

test('registro devuelve un token y /yo lo reconoce', async () => {
  const token = await registrar('angel@ejemplo.com')
  const r = await pedir({ method: 'GET', url: '/api/yo', headers: auth(token) })
  assert.equal(r.json().usuario, 'angel@ejemplo.com')
})

test('no se puede registrar dos veces el mismo usuario', async () => {
  await registrar('angel@ejemplo.com')
  const r = await pedir({
    method: 'POST', url: '/api/registro', payload: { usuario: 'ANGEL@EJEMPLO.COM', clave: 'kamehameha' },
  })
  // utf8mb4_unicode_ci no distingue mayusculas: Angel y angel son el mismo.
  assert.equal(r.statusCode, 409, r.body)
})

test('clave incorrecta no entra, y el mensaje no delata si el usuario existe', async () => {
  await registrar('angel@ejemplo.com')
  const mala = await pedir({
    method: 'POST', url: '/api/sesion', payload: { usuario: 'angel@ejemplo.com', clave: 'otracosa' },
  })
  const inexistente = await pedir({
    method: 'POST', url: '/api/sesion', payload: { usuario: 'goku@ejemplo.com', clave: 'otracosa' },
  })
  assert.equal(mala.statusCode, 401)
  assert.equal(inexistente.statusCode, 401)
  assert.deepEqual(mala.json(), inexistente.json())
})

test('entrar con la clave correcta devuelve un token que sirve', async () => {
  await registrar('angel@ejemplo.com')
  const r = await pedir({
    method: 'POST', url: '/api/sesion', payload: { usuario: 'angel@ejemplo.com', clave: 'kamehameha' },
  })
  assert.equal(r.statusCode, 200)
  const yo = await pedir({ method: 'GET', url: '/api/yo', headers: auth(r.json().token) })
  assert.equal(yo.json().usuario, 'angel@ejemplo.com')
})

test('sin token no se lee ni se escribe nada', async () => {
  for (const [method, url] of [['GET', '/api/coleccion'], ['PUT', '/api/cartas/exp-1:5']]) {
    const r = await pedir({ method, url, payload: { cantidad: 1 } })
    assert.equal(r.statusCode, 401, `${method} ${url}`)
  }
})

test('LA IMPORTANTE: la colección de uno no se le aparece al otro', async () => {
  const angel = await registrar('angel@ejemplo.com')
  const goku = await registrar('goku@ejemplo.com')

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
  const token = await registrar('angel@ejemplo.com')
  const poner = (cuerpo) => pedir({
    method: 'PUT', url: '/api/cartas/exp-2:140', headers: auth(token), payload: cuerpo,
  })
  await poner({ cantidad: 2, estado: 'reemplazar' })
  await poner({ cantidad: 0, estado: 'reemplazar' })

  const r = await pedir({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.deepEqual(r.json(), { estados: {}, cantidades: {} })
})

test('no se guarda basura: claves raras, cantidades negativas, estados inventados', async () => {
  const token = await registrar('angel@ejemplo.com')
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
  const token = await registrar('angel@ejemplo.com')
  await pedir({ method: 'DELETE', url: '/api/sesion', headers: auth(token) })
  const r = await pedir({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.equal(r.statusCode, 401)
})

test('borrar el usuario se lleva sus cartas y sus sesiones', async () => {
  const token = await registrar('angel@ejemplo.com')
  await pedir({
    method: 'PUT', url: '/api/cartas/exp-1:9', headers: auth(token), payload: { cantidad: 1 },
  })
  await pool.query('DELETE FROM usuario WHERE usuario = ?', ['angel@ejemplo.com'])

  const [cartas] = await pool.query('SELECT count(*) n FROM carta')
  const [sesiones] = await pool.query('SELECT count(*) n FROM sesion')
  assert.equal(cartas[0].n, 0, 'quedaron cartas huérfanas')
  assert.equal(sesiones[0].n, 0, 'quedaron sesiones huérfanas')
})

test('reemplazar la colección entera deja sólo lo nuevo', async () => {
  const token = await registrar('angel@ejemplo.com')
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

/* EL QUE BORRABA LA COLECCIÓN. Restaurar con un archivo que no era una copia —un null,
   un [], un {} o un respaldo bajado antes de cargar nada— llegaba acá como un reemplazo
   de cero cartas, se contestaba 200 y se borraba todo. Sin confirmación y sin aviso. */
test('un reemplazo sin cartas se rechaza y no toca nada de lo que había', async () => {
  const token = await registrar('goten@ejemplo.com')
  await pedir({ method: 'PUT', url: '/api/cartas/exp-1:1', headers: auth(token), payload: { cantidad: 2, estado: 'bien' } })
  await pedir({ method: 'PUT', url: '/api/cartas/exp-1:2', headers: auth(token), payload: { cantidad: 1, estado: 'perfecta' } })

  for (const cuerpo of [{ estados: {}, cantidades: {} }, { cantidades: {} }]) {
    const r = await pedir({ method: 'PUT', url: '/api/coleccion', headers: auth(token), payload: cuerpo })
    assert.equal(r.statusCode, 400, `tendría que rechazarlo: ${r.body}`)
  }

  const quedan = await pedir({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.deepEqual(Object.keys(quedan.json().cantidades).sort(), ['exp-1:1', 'exp-1:2'])
  assert.equal(quedan.json().cantidades['exp-1:1'], 2, 'ni siquiera las cantidades cambian')
})

test('una colección entera de 1936 cartas entra sin romperse', async () => {
  const token = await registrar('angel@ejemplo.com')
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
  // 'angel' entra acá ahora: sin arroba no alcanza para crear una cuenta.
  for (const malo of ['angel', 'ab', 'con espacio', 'sin@punto', 'a'.repeat(70)]) {
    const r = await pedir({
      method: 'POST', url: '/api/registro', payload: { usuario: malo, clave: 'kamehameha' },
    })
    assert.equal(r.statusCode, 400, `"${malo.slice(0, 20)}" devolvió ${r.statusCode}`)
  }
})

/* Los dos tests del freno usan una CF-Connecting-IP propia cada uno, a propósito: el
   balde es por IP y vive en el `app`, que es uno solo para todo el archivo. Si gastaran
   el de 127.0.0.1 —el socket de app.inject— los demás tests empezarían a comer 429. */

test('el freno cuenta por IP de verdad: una cabecera inventada no estrena contador', async () => {
  // Es el agujero del trustProxy: con `true`, Fastify tomaba el X-Forwarded-For que
  // manda el cliente, así que cada intento con una IP distinta era un balde nuevo y el
  // tope no existía.
  const codigos = []
  for (let i = 0; i < 13; i++) {
    const r = await pedir({
      method: 'POST',
      url: '/api/sesion',
      headers: { 'cf-connecting-ip': '10.9.9.1', 'x-forwarded-for': `198.51.100.${i}` },
      payload: { usuario: `nadie-${i}@ejemplo.com`, clave: 'claveMala1' },
    })
    codigos.push(r.statusCode)
  }
  assert.ok(codigos.includes(429), `nunca frenó: ${codigos.join(',')}`)
  assert.equal(codigos.at(-1), 429, 'el último tendría que estar frenado')
  // Y el freno es de esa IP, no de todos: otra sigue pudiendo intentar.
  const otra = await pedir({
    method: 'POST', url: '/api/sesion',
    headers: { 'cf-connecting-ip': '10.9.9.99' },
    payload: { usuario: 'nadie@ejemplo.com', clave: 'claveMala1' },
  })
  assert.equal(otra.statusCode, 401, 'el balde no puede ser uno solo para todos')
})

test('el registro también tiene freno, y no hashea si el usuario ya existe', async () => {
  const codigos = []
  for (let i = 0; i < 13; i++) {
    const r = await pedir({
      method: 'POST',
      url: '/api/registro',
      headers: { 'cf-connecting-ip': '10.9.9.2' },
      payload: { usuario: `basura-${i}@ejemplo.com`, clave: 'kamehameha' },
    })
    codigos.push(r.statusCode)
  }
  assert.ok(codigos.includes(429), `el registro no frenó nunca: ${codigos.join(',')}`)

  // Y el duplicado se rechaza antes del scrypt: sigue dando 409, que es lo que se ve
  // desde afuera. Lo que cambia es que ya no se paga el hash para tirarlo.
  await registrar('gohan@ejemplo.com')
  const repe = await pedir({
    method: 'POST', url: '/api/registro',
    headers: { 'cf-connecting-ip': '10.9.9.3' },
    payload: { usuario: 'gohan@ejemplo.com', clave: 'otraClave1' },
  })
  assert.equal(repe.statusCode, 409, repe.body)
})

test('la sesión dura 30 días y no más', async () => {
  await registrar('angel@ejemplo.com')
  const [filas] = await pool.query('SELECT DATEDIFF(vence, NOW()) dias FROM sesion')
  assert.equal(filas.length, 1, 'debería haber una sola sesión recién creada')
  // Un día de margen: la cuenta la hace MySQL con su propio reloj.
  assert.ok(Math.abs(filas[0].dias - 30) <= 1, `la sesión duró ${filas[0].dias} días`)
})
