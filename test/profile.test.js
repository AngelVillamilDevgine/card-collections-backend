// «Mi perfil» y la clave provisoria desde el panel.
//
// Lo que más importa: que nadie pueda leer ni escribir el perfil de otro (el id sale del
// token), que la validación frene lo que no es un dato, y que el botón del panel sea SÓLO
// del admin — a cualquier otro, 404, igual que el resumen.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { conectar, prepararEsquema } from '../src/base.js'
import { validateProfile, normalizeWhatsapp } from '../src/profile.js'
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
/* Lo que vuelve: el WhatsApp en E.164 sin «+», sólo dígitos. */
const STORED = { ...FULL, whatsapp: '5493516710050' }

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

/* Cómo lo escribe la gente de acá, y cómo tiene que quedar en la base: todo junto, sólo
   dígitos, y con el 9 que WhatsApp necesita en un celular argentino. LA MISMA LISTA está en
   el phone.test.js del front: los dos lados normalizan por su cuenta. */
const SAME_NUMBER = [
  '351 671-0050', '3516710050', '0351 15 671-0050', '(0351) 15-6710050', '351 15 671 0050',
  '+54 9 351 671-0050', '+54 351 671 0050', '+54 351 15 671 0050', '5493516710050', '0054 9 351 6710050',
  '9 351 671 0050', '9 351 15 671 0050', '+54 9 351 15 671-0050',
]

test('el WhatsApp se guarda todo junto y sólo con dígitos, se escriba como se escriba', () => {
  for (const typed of SAME_NUMBER) assert.equal(normalizeWhatsapp(typed).digits, '5493516710050', typed)
  assert.equal(normalizeWhatsapp('11 5555-1234').digits, '5491155551234')
  assert.equal(normalizeWhatsapp('011 15 5555-1234').digits, '5491155551234')
  assert.equal(normalizeWhatsapp('2964 12-3456').digits, '5492964123456') // característica de 4
  assert.equal(normalizeWhatsapp('+598 94 123 456').digits, '59894123456')
  assert.equal(normalizeWhatsapp('+34 612 34 56 78').digits, '34612345678')
  assert.equal(normalizeWhatsapp('+52 1 55 1234 5678').digits, '525512345678') // el 1 que usa WhatsApp en México
  assert.equal(normalizeWhatsapp('+52 55 1234 5678').digits, '525512345678')
  assert.equal(validateProfile({ whatsapp: '+54 9 351 671-0050' }).data.whatsapp, '5493516710050')
})

test('el WhatsApp no acepta letras, ni un número a medias, ni uno que no existe', () => {
  assert.match(validateProfile({ whatsapp: 'mi cel' }).error, /sólo con números/)
  assert.match(validateProfile({ whatsapp: '351 671-005O' }).error, /sólo con números/) // una O, no un cero
  assert.match(validateProfile({ whatsapp: '123' }).error, /incompleto/)
  assert.match(validateProfile({ whatsapp: '351 671-005' }).error, /incompleto/)
  assert.match(validateProfile({ whatsapp: '15 671-0050' }).error, /incompleto/) // sin característica
  assert.match(validateProfile({ whatsapp: '351 671-0050 1234' }).error, /no parece/)
  assert.match(validateProfile({ whatsapp: '+999 1234 5678' }).error, /no parece/)
})

/* Los de la revisión del 2026-09-30: cada uno pasaba y se guardaba. */
test('lo que tiene el largo justo pero no es un celular de nadie, no pasa', () => {
  assert.match(normalizeWhatsapp('9 15 5555 1234').error, /no parece/) // el 15 en lugar del 11
  assert.match(normalizeWhatsapp('0800 123 4567').error, /no parece/)
  assert.match(normalizeWhatsapp('0810 123 4567').error, /no parece/)
  assert.match(normalizeWhatsapp('+54 9 0000000000').error, /no parece/)
  assert.match(normalizeWhatsapp('+800 1234 5678').error, /no parece/) // sin país: no tiene WhatsApp
  assert.match(normalizeWhatsapp('+49 212345678901234').error, /no parece/) // 17 dígitos: no es un E.164
})

test('un número de acá sin «+» nunca se lee como de otro país', () => {
  assert.match(normalizeWhatsapp('299 824842').error, /incompleto/) // era Groenlandia
  assert.match(normalizeWhatsapp('358 642686').error, /incompleto/) // era Finlandia
  assert.match(normalizeWhatsapp('36 516 710 050').error, /no parece/) // era Hungría
})

/* La migración: lo que se guardó con el campo de texto libre (las horas entre «Mi perfil»
   y el campo de teléfono) pasa a la forma nueva. Una vez todo, con la marca en el
   comentario de la columna, y después en cada arranque lo que la versión vieja haya
   guardado con formato mientras convivían. */
const whatsappColumn = async () => {
  const [[col]] = await pool.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH len, COLUMN_COMMENT note FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuario' AND COLUMN_NAME = 'whatsapp'`
  )
  return col
}
const quietly = async (fn) => {
  const warn = console.warn
  const warned = []
  console.warn = (m) => warned.push(m)
  try { await fn() } finally { console.warn = warn }
  return warned
}
const numbers = async () => {
  const [rows] = await pool.query('SELECT usuario, whatsapp FROM usuario ORDER BY usuario')
  return Object.fromEntries(rows.map((r) => [r.usuario, r.whatsapp]))
}

test('lo guardado antes pasa a sólo dígitos, lo ilegible queda vacío, y no se lee dos veces', async () => {
  await pool.query("ALTER TABLE usuario MODIFY COLUMN whatsapp VARCHAR(30) NULL COMMENT ''")
  const legacy = {
    'a@x.com': '351 671-0050', 'b@x.com': '+54 9 11 5555-1234', 'c@x.com': '3516710050', 'd@x.com': 'mi cel',
    'e@x.com': null, 'f@x.com': '6581234567', 'g@x.com': '299 824842',
  }
  for (const [user, whatsapp] of Object.entries(legacy))
    await pool.query("INSERT INTO usuario (usuario, hash, whatsapp) VALUES (?, 'x', ?)", [user, whatsapp])
  const warned = await quietly(async () => {
    await prepararEsquema(pool)
    await prepararEsquema(pool) // la segunda no toca nada
  })
  assert.deepEqual(await numbers(), {
    'a@x.com': '5493516710050', 'b@x.com': '5491155551234', 'c@x.com': '5493516710050', 'd@x.com': null,
    'e@x.com': null,
    'f@x.com': '6581234567', // ya era la forma nueva (Singapur): no se vuelve a leer «a la argentina»
    'g@x.com': null, // le falta un dígito: vacío, no Groenlandia
  })
  assert.equal(warned.length, 2)
  assert.match(warned.join(' '), /mi cel/)
  assert.match(warned.join(' '), /299 824842/)
  /* El ancho NO se achica: la versión vieja convive durante el deploy y guarda hasta 30. */
  assert.deepEqual({ ...(await whatsappColumn()) }, { len: 30, note: 'e164' })
})

test('lo que la versión vieja guarde con formato después, lo convierte el próximo arranque', async () => {
  await pool.query("INSERT INTO usuario (usuario, hash, whatsapp) VALUES ('a@x.com', 'x', '5493516710050'), ('b@x.com', 'x', '11 4444-9999')")
  await quietly(() => prepararEsquema(pool))
  assert.deepEqual(await numbers(), { 'a@x.com': '5493516710050', 'b@x.com': '5491144449999' })
})

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
  assert.deepEqual(put.json(), { usuario: ANA, ...STORED })
  const get = await app.inject({ method: 'GET', url: '/api/profile', headers: auth(token) })
  assert.deepEqual(get.json(), { usuario: ANA, ...STORED })
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
  assert.deepEqual(row.profile, STORED)
  assert.equal(row.mustChange, false)
})
