// Lo que se prueba acá no es que compile: es que la colección de uno no se filtre
// a la cuenta del otro.
//
// Necesita un MySQL de verdad, porque el SQL es la mitad de lo que hay que probar.
// Levantar uno descartable:
//   docker run -d --name dbz-mysql-prueba -e MYSQL_ROOT_PASSWORD=prueba \
//     -e MYSQL_DATABASE=dbz_prueba -p 3307:3306 mysql:8
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createDbPool, prepareSchema } from '../src/db.js'
import { createApp } from '../src/servidor.js'
import { clearVisitMarks } from '../src/stats.js'
import { replaceCollection, MAX_REPLACE_KEYS } from '../src/collection.js'
import { hashPassword } from '../src/auth.js'

const TEST_DB_URL = process.env.DBZ_MYSQL_URL_TEST
  ?? 'mysql://root:prueba@127.0.0.1:3307/dbz_prueba'

let pool
let app

before(async () => {
  pool = createDbPool(TEST_DB_URL)
  await prepareSchema(pool)
  app = createApp(pool)
  await app.ready()
})

after(async () => {
  await app?.close()
  await pool?.end()
})

/* Cada test arranca con la base vacía, o los contadores del anterior se le mezclan.
   Borrar usuario alcanza: carta y sesion caen por ON DELETE CASCADE.

   Y se vacía también el Map de visitas anotadas, que es de módulo y sobrevive al DELETE.
   Hoy no haría falta —el AUTO_INCREMENT no se reinicia, así que cada usuario nuevo
   estrena id—, pero eso es una casualidad: el día que este DELETE pase a ser un TRUNCATE
   el usuario 1 se encontraría su propia marca del test anterior, la visita no se
   anotaría nunca y el test se colgaría esperándola. */
beforeEach(async () => {
  await pool.query('DELETE FROM usuario')
  clearVisitMarks()
})

/* Cada pedido de los tests sale con su propia IP, salvo que el test diga otra cosa: el
   freno a la fuerza bruta es por IP y el balde vive en el `app`, que es uno solo para
   todo el archivo. Sin esto los tests se comen el balde entre ellos —ahora que el
   registro también frena— y los últimos empiezan a recibir 429 por culpa de los
   primeros. */
let clientSeq = 0
const request = (options) =>
  app.inject({
    ...options,
    headers: { 'cf-connecting-ip': `10.0.${(++clientSeq / 250) | 0}.${clientSeq % 250}`, ...options.headers },
  })

async function register(user, password = 'kamehameha') {
  const r = await request({ method: 'POST', url: '/api/registro', payload: { usuario: user, clave: password } })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().token
}

const auth = (token) => ({ authorization: `Bearer ${token}` })

test('registro devuelve un token y /yo lo reconoce', async () => {
  const token = await register('angel@ejemplo.com')
  const r = await request({ method: 'GET', url: '/api/yo', headers: auth(token) })
  assert.equal(r.json().usuario, 'angel@ejemplo.com')
})

test('no se puede registrar dos veces el mismo usuario', async () => {
  await register('angel@ejemplo.com')
  const r = await request({
    method: 'POST', url: '/api/registro', payload: { usuario: 'ANGEL@EJEMPLO.COM', clave: 'kamehameha' },
  })
  // utf8mb4_unicode_ci no distingue mayusculas: Angel y angel son el mismo.
  assert.equal(r.statusCode, 409, r.body)
})

test('clave incorrecta no entra, y el mensaje no delata si el usuario existe', async () => {
  await register('angel@ejemplo.com')
  const wrongPassword = await request({
    method: 'POST', url: '/api/sesion', payload: { usuario: 'angel@ejemplo.com', clave: 'otracosa' },
  })
  const unknownUser = await request({
    method: 'POST', url: '/api/sesion', payload: { usuario: 'goku@ejemplo.com', clave: 'otracosa' },
  })
  assert.equal(wrongPassword.statusCode, 401)
  assert.equal(unknownUser.statusCode, 401)
  assert.deepEqual(wrongPassword.json(), unknownUser.json())
})

test('entrar con la clave correcta devuelve un token que sirve', async () => {
  await register('angel@ejemplo.com')
  const r = await request({
    method: 'POST', url: '/api/sesion', payload: { usuario: 'angel@ejemplo.com', clave: 'kamehameha' },
  })
  assert.equal(r.statusCode, 200)
  const me = await request({ method: 'GET', url: '/api/yo', headers: auth(r.json().token) })
  assert.equal(me.json().usuario, 'angel@ejemplo.com')
})

test('sin token no se lee ni se escribe nada', async () => {
  for (const [method, url] of [['GET', '/api/coleccion'], ['PUT', '/api/cartas/exp-1:5']]) {
    const r = await request({ method, url, payload: { cantidad: 1 } })
    assert.equal(r.statusCode, 401, `${method} ${url}`)
  }
})

test('LA IMPORTANTE: la colección de uno no se le aparece al otro', async () => {
  const angel = await register('angel@ejemplo.com')
  const goku = await register('goku@ejemplo.com')

  await request({
    method: 'PUT', url: '/api/cartas/exp-1:5', headers: auth(angel),
    payload: { cantidad: 3, estado: 'perfecta' },
  })

  const ownCollection = await request({ method: 'GET', url: '/api/coleccion', headers: auth(angel) })
  assert.deepEqual(ownCollection.json(), { estados: { 'exp-1:5': 'perfecta' }, cantidades: { 'exp-1:5': 3 } })

  const otherCollection = await request({ method: 'GET', url: '/api/coleccion', headers: auth(goku) })
  assert.deepEqual(otherCollection.json(), { estados: {}, cantidades: {} })

  // Y si goku escribe la misma clave, no pisa la de angel: la primaria las separa.
  await request({
    method: 'PUT', url: '/api/cartas/exp-1:5', headers: auth(goku), payload: { cantidad: 1 },
  })
  const afterward = await request({ method: 'GET', url: '/api/coleccion', headers: auth(angel) })
  assert.equal(afterward.json().cantidades['exp-1:5'], 3)
})

test('cantidad 0 borra la carta y su condición', async () => {
  const token = await register('angel@ejemplo.com')
  const putCard = (body) => request({
    method: 'PUT', url: '/api/cartas/exp-2:140', headers: auth(token), payload: body,
  })
  await putCard({ cantidad: 2, estado: 'reemplazar' })
  await putCard({ cantidad: 0, estado: 'reemplazar' })

  const r = await request({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.deepEqual(r.json(), { estados: {}, cantidades: {} })
})

test('no se guarda basura: claves raras, cantidades negativas, estados inventados', async () => {
  const token = await register('angel@ejemplo.com')
  const cases = [
    ['/api/cartas/..%2F..%2Fetc', { cantidad: 1 }],
    ['/api/cartas/exp-1:5', { cantidad: -3 }],
    ['/api/cartas/exp-1:5', { cantidad: 1.5 }],
    ['/api/cartas/exp-1:5', { cantidad: 1, estado: 'brillante' }],
  ]
  for (const [url, payload] of cases) {
    const r = await request({ method: 'PUT', url, headers: auth(token), payload })
    assert.equal(r.statusCode, 400, `${url} devolvió ${r.statusCode}`)
  }
})

test('cerrar sesión invalida el token', async () => {
  const token = await register('angel@ejemplo.com')
  await request({ method: 'DELETE', url: '/api/sesion', headers: auth(token) })
  const r = await request({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.equal(r.statusCode, 401)
})

test('borrar el usuario se lleva sus cartas y sus sesiones', async () => {
  const token = await register('angel@ejemplo.com')
  await request({
    method: 'PUT', url: '/api/cartas/exp-1:9', headers: auth(token), payload: { cantidad: 1 },
  })
  await pool.query('DELETE FROM usuario WHERE usuario = ?', ['angel@ejemplo.com'])

  const [cardRows] = await pool.query('SELECT count(*) n FROM carta')
  const [sessionRows] = await pool.query('SELECT count(*) n FROM sesion')
  assert.equal(cardRows[0].n, 0, 'quedaron cartas huérfanas')
  assert.equal(sessionRows[0].n, 0, 'quedaron sesiones huérfanas')
})

test('reemplazar la colección entera deja sólo lo nuevo', async () => {
  const token = await register('angel@ejemplo.com')
  await request({
    method: 'PUT', url: '/api/cartas/exp-1:1', headers: auth(token), payload: { cantidad: 9 },
  })
  const r = await request({
    method: 'PUT', url: '/api/coleccion', headers: auth(token),
    payload: { estados: { 'exp-3:300': 'bien' }, cantidades: { 'exp-3:300': 2 } },
  })
  assert.equal(r.json().cartas, 1)

  const final = await request({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.deepEqual(final.json().cantidades, { 'exp-3:300': 2 })
})

/* EL QUE BORRABA LA COLECCIÓN. Restaurar con un archivo que no era una copia —un null,
   un [], un {} o un respaldo bajado antes de cargar nada— llegaba acá como un reemplazo
   de cero cartas, se contestaba 200 y se borraba todo. Sin confirmación y sin aviso. */
test('un reemplazo sin cartas se rechaza y no toca nada de lo que había', async () => {
  const token = await register('goten@ejemplo.com')
  await request({ method: 'PUT', url: '/api/cartas/exp-1:1', headers: auth(token), payload: { cantidad: 2, estado: 'bien' } })
  await request({ method: 'PUT', url: '/api/cartas/exp-1:2', headers: auth(token), payload: { cantidad: 1, estado: 'perfecta' } })

  /* Los dos primeros son los de siempre. El TERCERO es el que se colaba: claves validas,
     todas en cero. La guarda contaba CLAVES, asi que pasaba entero; despues replaceCollection()
     filtra por n > 0 y no inserta nada, o sea que borraba todo y contestaba 200 con
     cartas: 0. Esta es la unica capa que protege si el front tiene un bug, y no protegia
     de esto. */
  for (const body of [
    { estados: {}, cantidades: {} },
    { cantidades: {} },
    { cantidades: { 'exp-1:1': 0, 'exp-1:2': 0, 'exp-4:500': 0 } },
  ]) {
    const r = await request({ method: 'PUT', url: '/api/coleccion', headers: auth(token), payload: body })
    assert.equal(r.statusCode, 400, `tendría que rechazarlo: ${r.body}`)
  }

  const remaining = await request({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.deepEqual(Object.keys(remaining.json().cantidades).sort(), ['exp-1:1', 'exp-1:2'])
  assert.equal(remaining.json().cantidades['exp-1:1'], 2, 'ni siquiera las cantidades cambian')
})

test('una colección entera de 1936 cartas entra sin romperse', async () => {
  const token = await register('angel@ejemplo.com')
  const quantities = {}
  const conditions = {}
  for (let n = 1; n <= 1936; n++) {
    quantities[`exp-1:${n}`] = 1
    conditions[`exp-1:${n}`] = 'bien'
  }
  const r = await request({
    method: 'PUT', url: '/api/coleccion', headers: auth(token), payload: { estados: conditions, cantidades: quantities },
  })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.json().cartas, 1936)

  const final = await request({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.equal(Object.keys(final.json().cantidades).length, 1936)
})

test('/api/salud contesta sin token, para el healthcheck del deploy', async () => {
  const r = await request({ method: 'GET', url: '/api/salud' })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().bien, true)
})

/* EL BORDE EXACTO DE LA COLUMNA, no «uno largo». Acá había un mail de 50 caracteres
   contra un límite de 64: pasaba siempre y no probaba nada del límite. Y el test de al
   lado tenía un `'a'.repeat(70)` entre los rechazados, pero ése lo rechaza el formato —no
   tiene arroba— así que tampoco tocaba la regla del largo. O sea que la regla que impide
   que MySQL trunque un usuario, y con eso lo deje sin poder entrar, no estaba probada.

   Los 64 son el ancho de `usuario` y también lo que exige `validateSignupCredentials`: tienen
   que ser el mismo número, y esto es lo que lo obliga. */
test('un mail de 64 entra entero, y uno de 65 se rechaza con el motivo', async () => {
  const emailDomain = '@ejemplo.com'
  const exactFit = 'g'.repeat(64 - emailDomain.length) + emailDomain // con «a» sería un mail de prueba (signup.js)
  assert.equal(exactFit.length, 64)

  const r = await request({
    method: 'POST', url: '/api/registro', payload: { usuario: exactFit, clave: 'kamehameha' },
  })
  assert.equal(r.statusCode, 200, r.body)
  const me = await request({ method: 'GET', url: '/api/yo', headers: auth(r.json().token) })
  // Si la columna quedó corta, MySQL lo trunca y el usuario deja de poder entrar.
  assert.equal(me.json().usuario, exactFit)
  assert.equal(me.json().usuario.length, 64)

  const tooLong = 'a'.repeat(65 - emailDomain.length) + emailDomain
  assert.equal(tooLong.length, 65)
  const rejected = await request({
    method: 'POST', url: '/api/registro', payload: { usuario: tooLong, clave: 'kamehameha' },
  })
  assert.equal(rejected.statusCode, 400)
  assert.match(rejected.json().error, /largo/i,
    'y el motivo tiene que ser el LARGO, no el formato: si no, el día que se afloje el regex esto pasa sin probar nada')
})

/* LO QUE CONTESTA FASTIFY SOLO TAMBIÉN TIENE QUE ESTAR EN CASTELLANO. Su cuerpo de error
   es `{ statusCode, error, message }` y `error` es el NOMBRE del estado HTTP — «Bad
   Request», «Payload Too Large»—, que es justo el campo que lee el front porque es el que
   usan todas nuestras rutas. Así que un json cortado, un cuerpo enorme o una dirección
   que no existe le mostraban «Bad Request» a la persona, en el medio de una app en
   castellano. */
test('los errores que arma Fastify solo llegan en castellano', async () => {
  const cases = [
    ['un json cortado a la mitad', { method: 'POST', url: '/api/sesion', payload: '{"usuario":', headers: { 'content-type': 'application/json' } }],
    ['una dirección que no existe', { method: 'GET', url: '/api/no-existe-nada' }],
    ['un cuerpo de más de 2 MB', { method: 'POST', url: '/api/sesion', payload: JSON.stringify({ usuario: 'a'.repeat(3 * 1024 * 1024) }), headers: { 'content-type': 'application/json' } }],
  ]
  for (const [caseName, requestOptions] of cases) {
    const r = await request(requestOptions)
    assert.ok(r.statusCode >= 400, `${caseName}: esperaba un error y fue ${r.statusCode}`)
    const errorBody = r.json()
    assert.ok(errorBody.error, `${caseName}: sin campo error`)
    /* La lista es cerrada a propósito: un «no está en inglés» a ojo pasa cualquier cosa.
       Si alguna vez hace falta un mensaje nuevo, se agrega acá y se lo mira una vez. */
    const OUR_MESSAGES = [
      'No se entendió lo que mandó la app. Probá de nuevo.',
      'Eso es demasiado grande para mandarlo de una.',
      'Demasiados intentos. Probá en un rato.',
      'El servidor tuvo un problema. Probá de nuevo en un minuto.',
      'No se pudo completar la operación.',
      'Esa dirección no existe.',
    ]
    assert.ok(OUR_MESSAGES.includes(errorBody.error),
      `${caseName}: contestó «${errorBody.error}», que no es ninguno de los mensajes nuestros — Fastify arma los suyos en inglés`)
  }
})

test('sigue sin aceptar cualquier cosa de usuario', async () => {
  // 'angel' entra acá ahora: sin arroba no alcanza para crear una cuenta.
  for (const invalid of ['angel', 'ab', 'con espacio', 'sin@punto', 'a'.repeat(70)]) {
    const r = await request({
      method: 'POST', url: '/api/registro', payload: { usuario: invalid, clave: 'kamehameha' },
    })
    assert.equal(r.statusCode, 400, `"${invalid.slice(0, 20)}" devolvió ${r.statusCode}`)
  }
})

/* Los dos tests del freno usan una CF-Connecting-IP propia cada uno, a propósito: el
   balde es por IP y vive en el `app`, que es uno solo para todo el archivo. Si gastaran
   el de 127.0.0.1 —el socket de app.inject— los demás tests empezarían a comer 429. */

test('el freno cuenta por IP de verdad: una cabecera inventada no estrena contador', async () => {
  // Es el agujero del trustProxy: con `true`, Fastify tomaba el X-Forwarded-For que
  // manda el cliente, así que cada intento con una IP distinta era un balde nuevo y el
  // tope no existía.
  const statusCodes = []
  for (let i = 0; i < 13; i++) {
    const r = await request({
      method: 'POST',
      url: '/api/sesion',
      headers: { 'cf-connecting-ip': '10.9.9.1', 'x-forwarded-for': `198.51.100.${i}` },
      // Siempre la MISMA cuenta: el balde que frena es el de (ip, usuario).
      payload: { usuario: 'nadie@ejemplo.com', clave: 'claveMala1' },
    })
    statusCodes.push(r.statusCode)
  }
  assert.ok(statusCodes.includes(429), `nunca frenó: ${statusCodes.join(',')}`)
  assert.equal(statusCodes.at(-1), 429, 'el último tendría que estar frenado')
  // Y el freno es de esa IP, no de todos: otra sigue pudiendo intentar.
  const otherIp = await request({
    method: 'POST', url: '/api/sesion',
    headers: { 'cf-connecting-ip': '10.9.9.99' },
    payload: { usuario: 'nadie@ejemplo.com', clave: 'claveMala1' },
  })
  assert.equal(otherIp.statusCode, 401, 'el balde no puede ser uno solo para todos')
})

/* EL BOTON DE REINICIO. El freno contaba todos los intentos por IP y un login bueno
   borraba el balde entero, asi que al atacante le alcanzaba con registrarse una cuenta
   propia: diez tiros a la victima, uno bueno a la suya, y a empezar de nuevo. */
test('entrar a una cuenta propia no le borra el freno a la cuenta atacada', async () => {
  const VICTIM = 'victima@ejemplo.com'
  const ATTACKER = 'atacante@ejemplo.com'
  await register(VICTIM)
  await register(ATTACKER)
  const SAME_IP = { 'cf-connecting-ip': '10.7.7.7' }

  for (let i = 0; i < 11; i++)
    await request({ method: 'POST', url: '/api/sesion', headers: SAME_IP,
                    payload: { usuario: VICTIM, clave: 'noEsLaClave1' } })
  const blocked = await request({ method: 'POST', url: '/api/sesion', headers: SAME_IP,
                                  payload: { usuario: VICTIM, clave: 'noEsLaClave1' } })
  assert.equal(blocked.statusCode, 429, 'tendría que estar frenada')

  const ownLogin = await request({ method: 'POST', url: '/api/sesion', headers: SAME_IP,
                                   payload: { usuario: ATTACKER, clave: 'kamehameha' } })
  assert.equal(ownLogin.statusCode, 200, `el atacante tiene que poder entrar a la suya: ${ownLogin.body}`)

  const stillBlocked = await request({ method: 'POST', url: '/api/sesion', headers: SAME_IP,
                                       payload: { usuario: VICTIM, clave: 'noEsLaClave1' } })
  assert.equal(stillBlocked.statusCode, 429, 'el login bueno le borró el freno a la víctima')
})

/* El cuerpo del 401 ya era el mismo exista o no el usuario. El tiempo no: al inexistente
   se le contestaba al instante y al real recién después del scrypt. */
test('negar a un usuario que no existe cuesta lo mismo que a uno que sí', async () => {
  await register('existe@ejemplo.com')
  const timeFailedLogin = async (user) => {
    const start = process.hrtime.bigint()
    const r = await request({ method: 'POST', url: '/api/sesion', payload: { usuario: user, clave: 'claveIncorrecta1' } })
    assert.equal(r.statusCode, 401, r.body)
    return Number(process.hrtime.bigint() - start) / 1e6
  }
  const real = await timeFailedLogin('existe@ejemplo.com')
  const unknownUser = await timeFailedLogin('no-existe@ejemplo.com')
  // No se mide que sean iguales —eso sería frágil— sino que el inexistente TAMBIÉN
  // pague un scrypt. Sin el hash de descarte volvía en menos de un milisegundo.
  assert.ok(unknownUser > 15, `el inexistente volvió en ${unknownUser.toFixed(1)} ms: no hasheó nada`)
  assert.ok(real > 15, `el real volvió en ${real.toFixed(1)} ms`)
})

/* El camino que reemplaza TODO validaba menos que el que cambia una carta sola. */
test('el reemplazo masivo tampoco acepta cantidades basura', async () => {
  const token = await register('trunks@ejemplo.com')
  for (const [caseName, quantities] of [
    ['negativa', { 'exp-1:1': -3 }],
    ['decimal', { 'exp-1:1': 1.7 }],
    ['texto', { 'exp-1:1': 'hola' }],
    ['enorme', { 'exp-1:1': 999999999 }],
  ]) {
    const r = await request({ method: 'PUT', url: '/api/coleccion', headers: auth(token),
                              payload: { estados: {}, cantidades: quantities } })
    assert.equal(r.statusCode, 400, `${caseName} tendría que rechazarse: ${r.body}`)
  }
  // Y una buena sigue entrando.
  const validReplacement = await request({ method: 'PUT', url: '/api/coleccion', headers: auth(token),
                                           payload: { estados: { 'exp-1:1': 'bien' }, cantidades: { 'exp-1:1': 2 } } })
  assert.equal(validReplacement.statusCode, 200, validReplacement.body)
})

/* Las estadísticas convierten de UTC a -03:00 dando por sentado que el servidor está en
   UTC, y nada lo garantizaba: dependía de con qué huso levantara el contenedor. */
/* Con el bodyLimit de 2 MB entran mas de 139.000 claves de formato valido en un solo
   pedido, y no habia nada que lo impidiera: una cuenta podia dejar millones de filas en
   el MySQL que comparten los proyectos de clientes. */
/* El número sale de MAX_REPLACE_KEYS y no está escrito a mano, que era justo el problema: el
   test decía 3000 «porque el catálogo son 1936» y el día que el catálogo creció se puso
   rojo pidiendo que se rechazara algo que ahora tiene que entrar. */
test('un reemplazo que se pasa del tope se rechaza', async () => {
  const token = await register('bulma@ejemplo.com')
  const quantities = {}
  for (let n = 1; n <= MAX_REPLACE_KEYS + 1; n++) quantities[`exp-1:${n}`] = 1
  const r = await request({ method: 'PUT', url: '/api/coleccion', headers: auth(token),
                            payload: { estados: {}, cantidades: quantities } })
  assert.equal(r.statusCode, 400, r.body)
  assert.match(r.json().error, /demasiadas/i)
})

/* Las DOS colecciones juntas son 1936 + 1097 = 3033 claves, y eso tiene que entrar: si no,
   el día que alguien restaure un respaldo completo se encuentra con que el único camino de
   recuperación contesta 400. Este test es el que frena a quien baje el tope sin pensarlo. */
test('las dos colecciones juntas entran en un solo reemplazo', async () => {
  const token = await register('trunks@ejemplo.com')
  const quantities = {}
  for (let n = 1; n <= 1936; n++) quantities[`exp-1:${n}`] = 1
  for (let n = 1; n <= 1097; n++) quantities[`ley-1:${n}`] = 1
  assert.equal(Object.keys(quantities).length, 3033)
  const r = await request({ method: 'PUT', url: '/api/coleccion', headers: auth(token),
                            payload: { estados: {}, cantidades: quantities } })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.json().cartas, 3033)
})

test('la sesión de MySQL está en UTC, que es lo que las estadísticas dan por sentado', async () => {
  const [rows] = await pool.query(
    'SELECT @@session.time_zone timeZone, TIMEDIFF(NOW(), UTC_TIMESTAMP()) utcOffset'
  )
  assert.equal(rows[0].timeZone, '+00:00', `la sesión dice ${rows[0].timeZone}`)
  assert.equal(String(rows[0].utcOffset), '00:00:00', 'NOW() tiene que ser UTC')
})

test('el registro también tiene freno, y no hashea si el usuario ya existe', async () => {
  const statusCodes = []
  for (let i = 0; i < 13; i++) {
    const r = await request({
      method: 'POST',
      url: '/api/registro',
      headers: { 'cf-connecting-ip': '10.9.9.2' },
      payload: { usuario: `basura-${i}@ejemplo.com`, clave: 'kamehameha' },
    })
    statusCodes.push(r.statusCode)
  }
  assert.ok(statusCodes.includes(429), `el registro no frenó nunca: ${statusCodes.join(',')}`)

  // Y el duplicado se rechaza antes del scrypt: sigue dando 409, que es lo que se ve
  // desde afuera. Lo que cambia es que ya no se paga el hash para tirarlo.
  await register('gohan@ejemplo.com')
  const duplicate = await request({
    method: 'POST', url: '/api/registro',
    headers: { 'cf-connecting-ip': '10.9.9.3' },
    payload: { usuario: 'gohan@ejemplo.com', clave: 'otraClave1' },
  })
  assert.equal(duplicate.statusCode, 409, duplicate.body)
})

test('la sesión dura 30 días y no más', async () => {
  await register('angel@ejemplo.com')
  const [rows] = await pool.query('SELECT DATEDIFF(vence, NOW()) daysLeft FROM sesion')
  assert.equal(rows.length, 1, 'debería haber una sola sesión recién creada')
  // Un día de margen: la cuenta la hace MySQL con su propio reloj.
  assert.ok(Math.abs(rows[0].daysLeft - 30) <= 1, `la sesión duró ${rows[0].daysLeft} días`)
})

/* #79. Lo único que se probaba de la sesión era su FECHA de vencimiento, que es como
   probar que el candado dice 30 en la etiqueta sin probar que se cierra. Acá se vence
   una de verdad, en la base, y se mira qué contesta el servidor: un 401, que es lo que
   el front usa para mandarte a entrar de nuevo en vez de dejarte marcando al vacío. */
test('una sesión vencida no sirve, aunque el token exista', async () => {
  const token = await register('vegeta@ejemplo.com')
  const beforeExpiry = await request({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.equal(beforeExpiry.statusCode, 200, 'recién sacada tiene que servir')

  // Se la vence a mano: un día para atrás alcanza y no depende del reloj del test.
  await pool.query('UPDATE sesion SET vence = NOW() - INTERVAL 1 DAY')

  for (const url of ['/api/coleccion', '/api/yo']) {
    const r = await request({ method: 'GET', url, headers: auth(token) })
    assert.equal(r.statusCode, 401, `${url} tendría que dar 401: ${r.body}`)
  }
  const writeAttempt = await request({
    method: 'PUT', url: '/api/cartas/exp-1:1', headers: auth(token), payload: { cantidad: 1 },
  })
  assert.equal(writeAttempt.statusCode, 401, 'y tampoco tiene que dejar escribir')
})

/* #77. `replaceCollection` corre en transacción justamente para que un reemplazo a medias no
   exista: o entra toda la colección nueva, o queda intacta la vieja. Nada lo probaba, y
   es el único camino de la app que borra en masa — si la transacción se rompiera, el
   DELETE ya habría pasado y te quedarías sin nada.

   Se fuerza el fallo con una clave más larga que la columna, que revienta en el INSERT
   de la segunda tanda, DESPUÉS del DELETE. */
test('si el reemplazo falla a mitad de camino, la colección de antes queda entera', async () => {
  const token = await register('piccolo@ejemplo.com')
  const [[row]] = await pool.query('SELECT id FROM usuario WHERE usuario = ?', ['piccolo@ejemplo.com'])

  for (const [cardKey, quantity] of [['exp-1:1', 3], ['exp-1:2', 1], ['exp-2:7', 2]]) {
    await request({ method: 'PUT', url: `/api/cartas/${cardKey}`, headers: auth(token), payload: { cantidad: quantity, estado: 'bien' } })
  }

  const quantities = { 'exp-9:1': 1 }
  quantities['x'.repeat(60) + ':1'] = 1   // no entra en VARCHAR(40): el INSERT falla
  await assert.rejects(
    () => replaceCollection(pool, row.id, { estados: {}, cantidades: quantities }),
    'el reemplazo tiene que fallar, si no el test no prueba nada'
  )

  const remaining = await request({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.deepEqual(Object.keys(remaining.json().cantidades).sort(), ['exp-1:1', 'exp-1:2', 'exp-2:7'],
    'tiene que quedar la colección de antes, no un pedazo de la nueva')
  assert.equal(remaining.json().cantidades['exp-1:1'], 3, 'y con sus cantidades intactas')
})

/* #57. `{ estados = {} }` en la firma sólo salta con undefined, no con null, y entonces
   `conditions[cardKey]` reventaba con un 500 sin explicación. Un `estados: null` es lo que
   deja una copia vieja o un archivo armado a mano. */
test('un reemplazo con estados en null se guarda igual, sin reventar', async () => {
  const token = await register('krilin@ejemplo.com')
  const r = await request({
    method: 'PUT', url: '/api/coleccion', headers: auth(token),
    payload: { estados: null, cantidades: { 'exp-1:1': 2, 'exp-1:2': 1 } },
  })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.json().cartas, 2)
  const remaining = await request({ method: 'GET', url: '/api/coleccion', headers: auth(token) })
  assert.equal(remaining.json().cantidades['exp-1:1'], 2)
  assert.deepEqual(remaining.json().estados, {}, 'sin estados, pero con las cartas')
})

/* #56. La clave se validaba hasta 46 caracteres y la columna es VARCHAR(40): pasaba la
   validación y moría en el INSERT con un 500. */
test('una clave más larga que la columna se rechaza con 400, no con un 500', async () => {
  const token = await register('yamcha@ejemplo.com')
  /* 40 caracteres antes del ':' y 42 en total. El número importa: con 41 el regex viejo
     ya lo rechazaba y el test no probaba nada. Con 40 PASABA la validación vieja y moría
     en el INSERT contra VARCHAR(40), que es exactamente el agujero. */
  const tooLongKey = 'a'.repeat(40) + ':1'
  const r = await request({
    method: 'PUT', url: `/api/cartas/${tooLongKey}`, headers: auth(token), payload: { cantidad: 1 },
  })
  assert.equal(r.statusCode, 400, `tendría que ser 400 y fue ${r.statusCode}: ${r.body}`)

  const bulk = await request({
    method: 'PUT', url: '/api/coleccion', headers: auth(token),
    payload: { estados: {}, cantidades: { [tooLongKey]: 1 } },
  })
  assert.equal(bulk.statusCode, 400, `y por el camino masivo también: ${bulk.body}`)

  // Y la clave más larga que el catálogo usa de verdad sigue entrando.
  const real = await request({
    method: 'PUT', url: '/api/cartas/especial-gt:1936', headers: auth(token), payload: { cantidad: 1 },
  })
  assert.equal(real.statusCode, 204, real.body)   // guardar una carta contesta 204, sin cuerpo

  // Y el borde exacto del tope nuevo: 34 + ':' + 5 dígitos = 40, que es la columna justa.
  const exactFit = await request({
    method: 'PUT', url: `/api/cartas/${'b'.repeat(34)}:12345`, headers: auth(token), payload: { cantidad: 1 },
  })
  assert.equal(exactFit.statusCode, 204, `40 justos tienen que entrar: ${exactFit.body}`)
  const oneOver = await request({
    method: 'PUT', url: `/api/cartas/${'b'.repeat(35)}:12345`, headers: auth(token), payload: { cantidad: 1 },
  })
  assert.equal(oneOver.statusCode, 400, 'y uno más, no')
})

/* #58. Al dueño de una cuenta comprometida no le quedaba NADA que hacer: el token ajeno
   vive 30 días, no había cambio de clave ni forma de cortar sesiones, y la única salida
   era pedirle a Angel que borrara filas a mano.

   Las dos mitades van juntas a propósito y por eso se prueban juntas: cambiar la clave
   sin echar a las sesiones abiertas no echa a nadie —el token no sabe nada de la clave—,
   y echarlas sin cambiar la clave deja entrar de nuevo al que la sabe. */
test('cambiar la clave echa a las otras sesiones y deja viva la propia', async () => {
  const myToken = await register('bulma@ejemplo.com')
  // El intruso entra con la clave robada: es una sesión más, indistinguible.
  const intruderToken = (await request({
    method: 'POST', url: '/api/sesion', payload: { usuario: 'bulma@ejemplo.com', clave: 'kamehameha' },
  })).json().token
  assert.notEqual(intruderToken, myToken)
  for (const t of [myToken, intruderToken])
    assert.equal((await request({ method: 'GET', url: '/api/coleccion', headers: auth(t) })).statusCode, 200)

  const r = await request({
    method: 'PUT', url: '/api/clave', headers: auth(myToken),
    payload: { actual: 'kamehameha', nueva: 'otra-clave-larga' },
  })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.json().echadas, 1, 'tenía que echar exactamente a la otra sesión')

  assert.equal((await request({ method: 'GET', url: '/api/coleccion', headers: auth(myToken) })).statusCode, 200,
    'la sesión que pidió el cambio sobrevive: si no, te quedás afuera por cuidarte')
  assert.equal((await request({ method: 'GET', url: '/api/coleccion', headers: auth(intruderToken) })).statusCode, 401,
    'y la del intruso deja de servir en el acto')

  // Y la clave vieja ya no entra; la nueva sí.
  assert.equal((await request({ method: 'POST', url: '/api/sesion',
    payload: { usuario: 'bulma@ejemplo.com', clave: 'kamehameha' } })).statusCode, 401)
  assert.equal((await request({ method: 'POST', url: '/api/sesion',
    payload: { usuario: 'bulma@ejemplo.com', clave: 'otra-clave-larga' } })).statusCode, 200)
})

test('no se cambia la clave sin saber la actual, ni por una que no sirve', async () => {
  const token = await register('chichi@ejemplo.com')
  const cases = [
    ['con la actual equivocada', { actual: 'no-es-esa', nueva: 'una-clave-larga' }, 401],
    ['sin la actual', { nueva: 'una-clave-larga' }, 400],
    ['con una nueva corta', { actual: 'kamehameha', nueva: 'corta' }, 400],
    ['con la misma de siempre', { actual: 'kamehameha', nueva: 'kamehameha' }, 400],
    ['sin cuerpo', undefined, 400],
  ]
  for (const [caseName, payload, expected] of cases) {
    const r = await request({ method: 'PUT', url: '/api/clave', headers: auth(token), payload })
    assert.equal(r.statusCode, expected, `${caseName}: esperaba ${expected} y fue ${r.statusCode} (${r.body})`)
  }
  // Después de todo eso, la clave original sigue siendo la que sirve.
  assert.equal((await request({ method: 'POST', url: '/api/sesion',
    payload: { usuario: 'chichi@ejemplo.com', clave: 'kamehameha' } })).statusCode, 200)
})

/* LAS CUENTAS VIEJAS NO PODÍAN CAMBIAR LA CLAVE NUNCA, y son justo las que más razones
   tienen para rotarla. `/api/clave` pasaba el usuario de la cuenta por
   `validateSignupCredentials`, que exige formato de mail: a un nombre a secas —los que había
   antes de que registrarse pidiera mail, y hay varios en producción— le contestaba 400 con
   «Para crear tu cuenta hace falta un mail», en una pantalla donde no se crea ninguna
   cuenta. Y cambiar la clave es el único camino que existe para echar una sesión ajena.

   Registrarse ya no las deja crear, así que la fila va a mano: es lo que hay en la base. */
test('una cuenta vieja con nombre a secas puede cambiar su clave', async () => {
  await pool.query('INSERT INTO usuario (usuario, hash) VALUES (?, ?)',
    ['negrojarita15', await hashPassword('kamehameha')])
  const token = (await request({
    method: 'POST', url: '/api/sesion', payload: { usuario: 'negrojarita15', clave: 'kamehameha' },
  })).json().token
  assert.ok(token, 'entrar sí podía: el formato no se valida al entrar')

  const r = await request({
    method: 'PUT', url: '/api/clave', headers: auth(token),
    payload: { actual: 'kamehameha', nueva: 'una-clave-larga' },
  })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal((await request({ method: 'POST', url: '/api/sesion',
    payload: { usuario: 'negrojarita15', clave: 'una-clave-larga' } })).statusCode, 200)
  /* Y la regla de la clave sigue valiendo: lo que se sacó es la del NOMBRE, no la otra. */
  const shortPassword = await request({
    method: 'PUT', url: '/api/clave', headers: auth(token),
    payload: { actual: 'una-clave-larga', nueva: 'corta' },
  })
  assert.equal(shortPassword.statusCode, 400)
})

/* LOS DOS 401 DE `PUT /api/clave` TIENEN QUE DISTINGUIRSE, y el servidor es el único que
   sabe cuál mandó. El front trata esa ruta con `credentialsInBody: true` para que «tu clave
   actual no es esa» no te eche de una sesión sana; el precio era que una sesión MUERTA
   tampoco te echaba, y el diálogo quedaba sin salida — escribieras lo que escribieras no
   iba a andar nunca, con el token muerto todavía guardado. */
test('los dos 401 de cambiar la clave se distinguen por el cuerpo', async () => {
  const token = await register('dosunos@ejemplo.com')

  const wrongPassword = await request({
    method: 'PUT', url: '/api/clave', headers: auth(token),
    payload: { actual: 'no-es-esa', nueva: 'una-clave-larga' },
  })
  assert.equal(wrongPassword.statusCode, 401)
  assert.equal(wrongPassword.json().sesion, undefined,
    'la clave equivocada NO puede venir marcada como sesión: si no, te echa de una sesión sana')

  await pool.query('UPDATE sesion SET vence = NOW() - INTERVAL 1 DAY')
  const expired = await request({
    method: 'PUT', url: '/api/clave', headers: auth(token),
    payload: { actual: 'kamehameha', nueva: 'una-clave-larga' },
  })
  assert.equal(expired.statusCode, 401)
  assert.equal(expired.json().sesion, true,
    'la sesión vencida SÍ, o el front la muestra como un error del formulario')
})

test('sin sesión no se cambia la clave de nadie', async () => {
  await register('gohan@ejemplo.com')
  const r = await request({ method: 'PUT', url: '/api/clave', payload: { actual: 'kamehameha', nueva: 'una-clave-larga' } })
  assert.equal(r.statusCode, 401)
})

/* HSTS es por HOST: la cabecera que manda el front no cubre a api.cromeros.com.ar, y por
   esta puerta viajan el token en cada pedido y la clave al entrar. Va en TODAS las
   respuestas, incluidas las que fallan: un 401 por http:// filtra igual. */
test('todas las respuestas llevan HSTS, salgan bien o mal', async () => {
  const token = await register('hsts@ejemplo.com')
  const cases = [
    ['una ruta con sesión', { method: 'GET', url: '/api/coleccion', headers: auth(token) }],
    ['el healthcheck, sin token', { method: 'GET', url: '/api/salud' }],
    ['un 401', { method: 'GET', url: '/api/coleccion' }],
    ['un 404', { method: 'GET', url: '/api/no-existe' }],
    /* El preflight lo contesta el plugin de CORS adentro de su propio hook: si el hook de
       HSTS se da de alta después del register, este 204 sale sin la cabecera. Pasó. */
    ['el preflight de CORS', { method: 'OPTIONS', url: '/api/cartas/x', headers: {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'content-type,authorization',
    } }],
  ]
  for (const [caseName, requestOptions] of cases) {
    const r = await request(requestOptions)
    assert.equal(r.headers['strict-transport-security'], 'max-age=31536000',
      `${caseName} tendría que llevar HSTS y llevó: ${r.headers['strict-transport-security']}`)
  }
})


/* `carta` no tenía ninguna fecha, así que no se podía saber cuántas cartas se marcaron un
   día: alguien que abre la app y no toca nada y alguien que carga doscientas contaban
   igual en `visita`. La columna se llena sola con el upsert que ya existía —cero
   escrituras de más en el camino caliente— y las filas anteriores a la migración quedan
   en NULL, que es la verdad, en vez de todas con la fecha del día que se migró. */
test('cada carta guarda cuándo se tocó, y se actualiza al volver a tocarla', async () => {
  const token = await register('ten@ejemplo.com')
  await request({ method: 'PUT', url: '/api/cartas/exp-1:1', headers: auth(token), payload: { cantidad: 1, estado: 'bien' } })

  const [[row]] = await pool.query("SELECT marked_at, TIMESTAMPDIFF(SECOND, marked_at, NOW()) secondsAgo FROM carta WHERE clave = 'exp-1:1'")
  assert.ok(row.marked_at, 'una carta recién guardada tiene fecha')
  assert.ok(row.secondsAgo >= 0 && row.secondsAgo < 60, `la fecha tiene que ser de recién, y fue de hace ${row.secondsAgo}s`)

  // Volver a guardarla con OTRO número mueve la fecha.
  await pool.query("UPDATE carta SET marked_at = NOW() - INTERVAL 3 DAY WHERE clave = 'exp-1:1'")
  await request({ method: 'PUT', url: '/api/cartas/exp-1:1', headers: auth(token), payload: { cantidad: 4, estado: 'bien' } })
  const [[afterward]] = await pool.query("SELECT TIMESTAMPDIFF(SECOND, marked_at, NOW()) secondsAgo FROM carta WHERE clave = 'exp-1:1'")
  assert.ok(afterward.secondsAgo < 60, 'tocarla de nuevo tiene que mover la fecha')

  // Y guardarla con el MISMO número no es un cambio: la fecha no se mueve.
  await pool.query("UPDATE carta SET marked_at = NOW() - INTERVAL 3 DAY WHERE clave = 'exp-1:1'")
  await request({ method: 'PUT', url: '/api/cartas/exp-1:1', headers: auth(token), payload: { cantidad: 4, estado: 'bien' } })
  const [[unchanged]] = await pool.query("SELECT TIMESTAMPDIFF(DAY, marked_at, NOW()) daysAgo FROM carta WHERE clave = 'exp-1:1'")
  assert.equal(unchanged.daysAgo, 3, 'guardar lo mismo no cuenta como tocarla')
})

test('el reemplazo masivo también deja fecha', async () => {
  const token = await register('yajirobe@ejemplo.com')
  await request({ method: 'PUT', url: '/api/coleccion', headers: auth(token),
                  payload: { estados: {}, cantidades: { 'exp-1:1': 1, 'exp-1:2': 2 } } })
  const [rows] = await pool.query('SELECT marked_at FROM carta')
  assert.equal(rows.length, 2)
  assert.ok(rows.every((f) => f.marked_at), 'las dos tienen que tener fecha')
})
