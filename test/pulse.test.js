// La pasarela: los contadores anónimos del tramo de ANTES de tener cuenta.
//
// Lo que más importa acá es la lista blanca —la clave la manda el cliente, así que sin
// ella cualquiera crearía filas a voluntad— y que el resumen recorte sus «se anotaron»
// al arranque de la pasarela: comparar las visitas de hoy contra las altas históricas
// daría una conversión absurda.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { conectar, prepararEsquema } from '../src/base.js'
import { recordPulse, recordVisit, funnelSummary, deviceOf, PULSE_KEYS } from '../src/pulse.js'
import { resumen, olvidarVisitas, hoyAca } from '../src/estadisticas.js'

const URL = process.env.DBZ_MYSQL_URL_TEST ?? 'mysql://root:prueba@127.0.0.1:3307/dbz_prueba'

let pool
let app

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
  await pool.query('DELETE FROM pulse')
  await pool.query('DELETE FROM visitor')
  await pool.query('DELETE FROM visitor_day')
  await pool.query('DELETE FROM usuario')
  olvidarVisitas()
})

const filas = async () => {
  const [f] = await pool.query('SELECT day, k, n FROM pulse ORDER BY k')
  return f
}

/* La ruta no espera la escritura (nadie espera por una estadística), así que el test
   tiene que darle un respiro antes de mirar la tabla. */
const esperarFila = async (k) => {
  for (let i = 0; i < 40; i++) {
    const [f] = await pool.query('SELECT n FROM pulse WHERE k = ?', [k])
    if (f.length) return Number(f[0].n)
    await new Promise((r) => setTimeout(r, 25))
  }
  return null
}

test('una clave inventada NO crea fila: la lista blanca es el diseño', async () => {
  assert.equal(recordPulse(pool, 'x'.repeat(24), hoyAca()), null)
  assert.equal(recordPulse(pool, 'landing2', hoyAca()), null)
  assert.equal(recordPulse(pool, '', hoyAca()), null)
  assert.equal((await filas()).length, 0)
})

test('la misma clave dos veces es UNA fila con n=2, no dos filas', async () => {
  await recordPulse(pool, 'landing', hoyAca())
  await recordPulse(pool, 'landing', hoyAca())
  const f = await filas()
  assert.equal(f.length, 1)
  assert.equal(Number(f[0].n), 2)
})

test('sin ni una fila, la pasarela es null — no una pasarela de ceros', async () => {
  assert.equal(await funnelSummary(pool, hoyAca()), null)
})

test('el resumen agrupa los dos caminos que salen de la landing', async () => {
  await recordPulse(pool, 'landing', hoyAca())
  await recordPulse(pool, 'landing', hoyAca())
  await recordPulse(pool, 'login:hero', hoyAca())
  await recordPulse(pool, 'login:closing', hoyAca())
  await recordPulse(pool, 'login:hero-acct', hoyAca())
  await recordPulse(pool, 'login:direct', hoyAca())
  const f = await funnelSummary(pool, hoyAca())
  assert.equal(f.landing, 2)
  assert.equal(f.toSignup, 2) // hero + closing
  assert.equal(f.toLogin, 2) // hero-acct + direct
  assert.equal(f.since, hoyAca())
  assert.deepEqual(f.days, [{ dia: hoyAca(), n: 2 }])
})

test('POST /api/pulse con texto plano contesta 204 y anota', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/pulse',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    payload: 'landing',
  })
  assert.equal(r.statusCode, 204)
  assert.equal(await esperarFila('landing'), 1)
})

test('POST con una clave inventada contesta 204 IGUAL, y no anota nada', async () => {
  /* 204 siempre: un contador no es un oráculo de qué claves existen. */
  const r = await app.inject({
    method: 'POST',
    url: '/api/pulse',
    headers: { 'content-type': 'text/plain' },
    payload: 'DROP TABLE pulse',
  })
  assert.equal(r.statusCode, 204)
  await new Promise((x) => setTimeout(x, 150))
  assert.equal((await filas()).length, 0)
})

test('el resumen del panel lleva la pasarela, con las altas DESDE su arranque', async () => {
  /* Sin pulso: funnel null, y el resto del resumen intacto. */
  const antes = await resumen(pool)
  assert.equal(antes.funnel, null)
  assert.ok(antes.usuarios)

  await recordPulse(pool, 'landing', hoyAca())
  await pool.query('INSERT INTO usuario (usuario, hash) VALUES (?, ?)', ['a@b.com', 'x'])
  const d = await resumen(pool)
  assert.equal(d.funnel.landing, 1)
  /* El alta de recién es de hoy y la pasarela arrancó hoy: cuenta. */
  assert.equal(d.funnel.signups, 1)
})

const VID = 'abcdef0123456789'
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130 Mobile'

test('el mismo navegador diez veces es UNA persona con diez visitas', async () => {
  for (let i = 0; i < 10; i++) await recordVisit(pool, `v1|${VID}|0|0`, hoyAca(), UA_ANDROID)
  const f = await funnelSummary(pool, hoyAca())
  assert.equal(f.visitors.total, 1)
  assert.equal(f.visitors.today, 1)
  assert.equal(f.landing, 10) // las cargas crudas siguen contando todas
  const [[v]] = await pool.query('SELECT visits, device FROM visitor WHERE vid = ?', [VID])
  assert.equal(Number(v.visits), 10)
  assert.equal(v.device, 'android')
  /* Y la presencia del día es una sola fila, no diez. */
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM visitor_day'))[0][0].n), 1)
})

test('dos navegadores son DOS personas, tengan o no sesión', async () => {
  await recordVisit(pool, `v1|${VID}|1|0`, hoyAca(), UA_ANDROID)
  await recordVisit(pool, 'v1|1111222233334444|0|1', hoyAca(), 'Mozilla/5.0 (iPhone; CPU iPhone OS 17)')
  const f = await funnelSummary(pool, hoyAca())
  assert.equal(f.visitors.total, 2)
  assert.equal(f.visitors.withSession, 1)
  assert.equal(f.visitors.standalone, 1)
  assert.deepEqual(
    f.visitors.devices.sort((a, b) => a.device.localeCompare(b.device)),
    [{ device: 'android', n: 1 }, { device: 'iphone', n: 1 }]
  )
})

test('un vid que no es 16 hex cuenta la visita cruda y NADA más', async () => {
  await recordVisit(pool, "v1|'; DROP TABLE visitor; --|0|0", hoyAca(), UA_ANDROID)
  await recordVisit(pool, 'v1||0|0', hoyAca(), UA_ANDROID)
  const f = await funnelSummary(pool, hoyAca())
  assert.equal(f.landing, 2)
  assert.equal(f.visitors.total, 0)
})

test('las banderas suben y no bajan: entrar una vez marca al navegador para siempre', async () => {
  await recordVisit(pool, `v1|${VID}|0|0`, hoyAca(), UA_ANDROID)
  await recordVisit(pool, `v1|${VID}|1|0`, hoyAca(), UA_ANDROID)
  await recordVisit(pool, `v1|${VID}|0|0`, hoyAca(), UA_ANDROID)
  const [[v]] = await pool.query('SELECT with_session FROM visitor WHERE vid = ?', [VID])
  assert.equal(Number(v.with_session), 1)
})

test('el aparato sale del User-Agent, grueso a propósito', () => {
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'iphone')
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 14)'), 'android')
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows')
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'mac')
  assert.equal(deviceOf('curl/8.0'), 'otro')
  assert.equal(deviceOf(undefined), 'otro')
})

test('lo que antes caía en «otro» ahora tiene nombre, y el orden importa', () => {
  // Linux de escritorio (Huayra y compañía) y ChromeOS, que dice «X11» también.
  assert.equal(deviceOf('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36'), 'linux')
  assert.equal(deviceOf('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/130'), 'chromeos')
  // La Xbox dice «Windows» y los televisores «Linux»: van antes.
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox One) Edge/44'), 'consola')
  assert.equal(deviceOf('Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15'), 'consola')
  assert.equal(deviceOf('Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 SamsungBrowser/4.0'), 'tv')
  assert.equal(deviceOf('Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/87'), 'tv')
})

test('los robots no son personas — y Googlebot móvil dice «Android»', () => {
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'bot')
  assert.equal(deviceOf('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/130 Safari/537.36'), 'bot')
  assert.equal(deviceOf('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'), 'bot')
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 HeadlessChrome/153.0.0.0 Safari/537.36'), 'bot')
  // Y un celular CUBOT es un Android de verdad: `bot` va con bordes de palabra.
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 12; CUBOT X50) AppleWebKit/537.36 Chrome/130 Mobile'), 'android')
})

test('un robot no deja NADA: ni carga ni visitante', async () => {
  const googlebot = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X) Chrome/130 Mobile (compatible; Googlebot/2.1)'
  await recordVisit(pool, `v1|${VID}|0|0`, hoyAca(), googlebot)
  assert.equal((await filas()).length, 0)
  const [[v]] = await pool.query('SELECT COUNT(*) n FROM visitor')
  assert.equal(Number(v.n), 0)
})

test('un aparato sin identificar deja su UA en el log, no en la base', async () => {
  const anotado = []
  const log = { info: (obj, msg) => anotado.push({ ...obj, msg }) }
  await recordVisit(pool, `v1|${VID}|0|0`, hoyAca(), 'RaroBrowser/1.0', log)
  assert.deepEqual(anotado, [{ ua: 'RaroBrowser/1.0', msg: 'aparato sin identificar' }])
  const [[v]] = await pool.query('SELECT device FROM visitor WHERE vid = ?', [VID])
  assert.equal(v.device, 'otro')
})

test('POST /api/pulse con v1 anota al visitante con su aparato', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/pulse',
    headers: { 'content-type': 'text/plain', 'user-agent': UA_ANDROID },
    payload: `v1|${VID}|0|0`,
  })
  assert.equal(r.statusCode, 204)
  assert.equal(await esperarFila('landing'), 1)
  const [[v]] = await pool.query('SELECT device FROM visitor WHERE vid = ?', [VID])
  assert.equal(v.device, 'android')
})

test('las claves que mandan la landing y el formulario están TODAS en la lista blanca', () => {
  /* El contrato entre repos no se puede importar: el front manda estos literales
     (`temprano.js` y `Entrar.jsx`) y acá tienen que existir, o el contador pierde en
     silencio. Si se agrega un botón allá, se agrega su clave acá y en esta lista. */
  for (const k of ['landing', 'login:hero', 'login:closing', 'login:hero-acct', 'login:closing-acct', 'login:direct']) {
    assert.ok(PULSE_KEYS.has(k), `falta ${k} en PULSE_KEYS`)
  }
})
