// La pasarela: los contadores anónimos del tramo de ANTES de tener cuenta.
//
// Lo que más importa acá es la lista blanca —la clave la manda el cliente, así que sin
// ella cualquiera crearía filas a voluntad— y que el resumen recorte sus «se anotaron»
// al arranque de la pasarela: comparar las visitas de hoy contra las altas históricas
// daría una conversión absurda.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { conectar, prepararEsquema } from '../src/base.js'
import { recordPulse, funnelSummary, PULSE_KEYS } from '../src/pulse.js'
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

test('las claves que mandan la landing y el formulario están TODAS en la lista blanca', () => {
  /* El contrato entre repos no se puede importar: el front manda estos literales
     (`temprano.js` y `Entrar.jsx`) y acá tienen que existir, o el contador pierde en
     silencio. Si se agrega un botón allá, se agrega su clave acá y en esta lista. */
  for (const k of ['landing', 'login:hero', 'login:closing', 'login:hero-acct', 'login:closing-acct', 'login:direct']) {
    assert.ok(PULSE_KEYS.has(k), `falta ${k} en PULSE_KEYS`)
  }
})
